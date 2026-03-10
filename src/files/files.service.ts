import { ForbiddenException, Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  CreateOrganizationLogoUploadUrlInput,
  CreateProfileAvatarUploadUrlInput,
  CreateStartupDataRoomUploadUrlInput,
  CreateStartupPitchDeckUploadUrlInput,
  CreateStartupReadinessUploadUrlInput,
  type StartupDataRoomDocumentType,
} from './files.types';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class FilesService {
  private readonly s3: S3Client | null;
  private readonly bucketName: string | null;
  private readonly publicBaseUrl: string | null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const accountId = this.config.get<string>('r2AccountId');
    const accessKeyId = this.config.get<string>('r2AccessKeyId');
    const secretAccessKey = this.config.get<string>('r2SecretAccessKey');
    const bucketName = this.config.get<string>('r2BucketName');
    const publicBaseUrl = this.config.get<string>('r2PublicBaseUrl') ?? null;

    if (!accountId || !accessKeyId || !secretAccessKey || !bucketName) {
      this.s3 = null;
      this.bucketName = null;
      this.publicBaseUrl = null;
      return;
    }

    this.bucketName = bucketName;
    this.publicBaseUrl = publicBaseUrl;
    this.s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });
  }

  async createStartupPitchDeckUploadUrl(
    userId: string,
    input: CreateStartupPitchDeckUploadUrlInput,
  ): Promise<{ uploadUrl: string; publicUrl: string | null; objectKey: string }> {
    return this.createStartupReadinessUploadUrl(userId, {
      orgId: input.orgId,
      assetType: 'pitch_deck',
      fileName: input.fileName,
      contentType: input.contentType,
      contentLength: input.contentLength,
    });
  }

  private normalizeOptionalText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private async assertStartupUploadAccess(userId: string, orgId: string): Promise<void> {
    const rows = await this.prisma.$queryRaw<Array<{ allowed: boolean }>>`
      select exists (
        select 1
        from public.org_members om
        join public.organizations o on o.id = om.org_id
        left join public.org_status os on os.org_id = o.id
        where om.user_id = ${userId}::uuid
          and om.org_id = ${orgId}::uuid
          and om.status = 'active'
          and om.member_role = any (array['owner'::public.org_member_role, 'admin'::public.org_member_role])
          and o.type = 'startup'::public.org_type
          and coalesce(os.status::text, 'active') = 'active'
      ) as allowed
    `;

    if (rows[0]?.allowed !== true) {
      throw new ForbiddenException('Only startup owner or admin can upload readiness assets.');
    }
  }

  private buildPublicUrl(objectKey: string): string | null {
    if (!this.publicBaseUrl) {
      return null;
    }

    return `${this.publicBaseUrl.replace(/\/+$/, '')}/${objectKey}`;
  }

  private extractObjectKeyFromPublicUrl(publicUrl: string): string | null {
    if (!this.publicBaseUrl) {
      return null;
    }

    try {
      const base = this.publicBaseUrl.replace(/\/+$/, '');
      const baseUrl = new URL(base);
      const targetUrl = new URL(publicUrl);

      if (baseUrl.origin !== targetUrl.origin) {
        return null;
      }

      const basePath = baseUrl.pathname.replace(/\/+$/, '');
      let targetPath = targetUrl.pathname;

      if (basePath && !targetPath.startsWith(basePath)) {
        return null;
      }

      if (basePath && targetPath.startsWith(basePath)) {
        targetPath = targetPath.slice(basePath.length);
      }

      targetPath = targetPath.replace(/^\/+/, '');

      return targetPath.length > 0 ? targetPath : null;
    } catch {
      return null;
    }
  }

  async deleteObjectByPublicUrl(publicUrl: string): Promise<void> {
    if (!this.s3 || !this.bucketName) {
      return;
    }

    const objectKey = this.extractObjectKeyFromPublicUrl(publicUrl);
    if (!objectKey) {
      return;
    }

    try {
      await this.s3.send(
        new DeleteObjectCommand({
          Bucket: this.bucketName,
          Key: objectKey,
        }),
      );
    } catch {
      // Best-effort cleanup; failures are non-fatal.
      return;
    }
  }

  private assertImageContentType(contentType: string): void {
    const allowed = new Set([
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif',
      'image/svg+xml',
    ]);
    if (!allowed.has(contentType)) {
      throw new InternalServerErrorException(
        'Image must be JPG, PNG, WEBP, GIF, or SVG.',
      );
    }
  }

  async createStartupReadinessUploadUrl(
    userId: string,
    input: CreateStartupReadinessUploadUrlInput,
  ): Promise<{ uploadUrl: string; publicUrl: string | null; objectKey: string }> {
    if (!this.s3 || !this.bucketName) {
      throw new InternalServerErrorException('R2 storage is not configured');
    }

    const orgId = this.normalizeOptionalText(input.orgId);
    if (!orgId) {
      throw new InternalServerErrorException('Organization id is required.');
    }

    await this.assertStartupUploadAccess(userId, orgId);

    if (input.contentLength <= 0 || input.contentLength > 50 * 1024 * 1024) {
      throw new InternalServerErrorException('Readiness asset must be 50MB or smaller.');
    }

    const allowedMimeTypes =
      input.assetType === 'pitch_deck'
        ? new Set([
            'application/pdf',
            'application/vnd.ms-powerpoint',
            'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            'video/mp4',
            'video/webm',
            'video/quicktime',
          ])
        : new Set([
            'application/pdf',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'text/csv',
          ]);

    if (!allowedMimeTypes.has(input.contentType)) {
      if (input.assetType === 'pitch_deck') {
        throw new InternalServerErrorException('Pitch deck must be PDF/PPT/PPTX or MP4/WEBM/MOV.');
      }

      throw new InternalServerErrorException(
        'Readiness document must be PDF, DOC/DOCX, XLS/XLSX, or CSV.',
      );
    }

    const safeOrgId = orgId;
    const now = Date.now();
    const extension = this.resolveExtension(input.fileName, input.contentType, input.assetType);
    const logicalBucket = 'startup-data-room-assets';
    const relativePath = `${safeOrgId}/readiness/${input.assetType}-${now}.${extension}`;
    const objectKey = `${logicalBucket}/${relativePath}`;

    const putCommand = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: objectKey,
      ContentType: input.contentType,
    });

    const uploadUrl = await getSignedUrl(this.s3, putCommand, { expiresIn: 15 * 60 });

    const publicUrl = this.buildPublicUrl(objectKey);

    return { uploadUrl, publicUrl, objectKey };
  }

  async createStartupDataRoomUploadUrl(
    userId: string,
    input: CreateStartupDataRoomUploadUrlInput,
  ): Promise<{ uploadUrl: string; publicUrl: string | null; objectKey: string }> {
    if (!this.s3 || !this.bucketName) {
      throw new InternalServerErrorException('R2 storage is not configured');
    }

    const orgId = this.normalizeOptionalText(input.orgId);
    if (!orgId) {
      throw new InternalServerErrorException('Organization id is required.');
    }

    await this.assertStartupUploadAccess(userId, orgId);

    if (input.contentLength <= 0 || input.contentLength > 100 * 1024 * 1024) {
      throw new InternalServerErrorException('Data room asset must be 100MB or smaller.');
    }

    const pitchDeckMimeTypes = new Set([
      'application/pdf',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'video/mp4',
      'video/webm',
      'video/quicktime',
    ]);
    const documentMimeTypes = new Set([
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/csv',
      'text/plain',
    ]);

    const isPitchDeck = input.documentType === 'pitch_deck';
    const allowedMimeTypes = isPitchDeck ? pitchDeckMimeTypes : documentMimeTypes;
    if (!allowedMimeTypes.has(input.contentType)) {
      if (isPitchDeck) {
        throw new InternalServerErrorException('Pitch deck must be PDF/PPT/PPTX or MP4/WEBM/MOV.');
      }

      throw new InternalServerErrorException(
        'Data room document must be PDF, DOC/DOCX, XLS/XLSX, TXT, or CSV.',
      );
    }

    const safeOrgId = orgId;
    const now = Date.now();
    const extension = this.resolveDataRoomExtension(
      input.fileName,
      input.contentType,
      input.documentType,
    );
    const logicalBucket = 'startup-data-room-assets';
    const relativePath = `${safeOrgId}/data-room/${input.documentType}-${now}.${extension}`;
    const objectKey = `${logicalBucket}/${relativePath}`;

    const putCommand = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: objectKey,
      ContentType: input.contentType,
    });

    const uploadUrl = await getSignedUrl(this.s3, putCommand, { expiresIn: 15 * 60 });

    const publicUrl = this.buildPublicUrl(objectKey);

    return { uploadUrl, publicUrl, objectKey };
  }

  async createProfileAvatarUploadUrl(
    userId: string,
    input: CreateProfileAvatarUploadUrlInput,
  ): Promise<{ uploadUrl: string; publicUrl: string | null; objectKey: string }> {
    if (!this.s3 || !this.bucketName) {
      throw new InternalServerErrorException('R2 storage is not configured');
    }

    const normalizedUserId = this.normalizeOptionalText(userId);
    if (!normalizedUserId) {
      throw new InternalServerErrorException('User id is required.');
    }

    if (input.contentLength <= 0 || input.contentLength > 2 * 1024 * 1024) {
      throw new InternalServerErrorException('Profile avatar must be 2MB or smaller.');
    }

    this.assertImageContentType(input.contentType);

    const now = Date.now();
    const extension = this.resolveImageExtension(input.fileName, input.contentType);
    const logicalBucket = 'profile-avatars';
    const relativePath = `${normalizedUserId}/avatar-${now}.${extension}`;
    const objectKey = `${logicalBucket}/${relativePath}`;

    const putCommand = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: objectKey,
      ContentType: input.contentType,
    });

    const uploadUrl = await getSignedUrl(this.s3, putCommand, { expiresIn: 15 * 60 });
    const publicUrl = this.buildPublicUrl(objectKey);

    return { uploadUrl, publicUrl, objectKey };
  }

  async createOrganizationLogoUploadUrl(
    userId: string,
    input: CreateOrganizationLogoUploadUrlInput,
  ): Promise<{ uploadUrl: string; publicUrl: string | null; objectKey: string }> {
    if (!this.s3 || !this.bucketName) {
      throw new InternalServerErrorException('R2 storage is not configured');
    }

    const orgId = this.normalizeOptionalText(input.orgId);
    if (!orgId) {
      throw new InternalServerErrorException('Organization id is required.');
    }

    // Reuse startup upload access check: owners/admins of the org.
    await this.assertStartupUploadAccess(userId, orgId);

    if (input.contentLength <= 0 || input.contentLength > 2 * 1024 * 1024) {
      throw new InternalServerErrorException('Organization logo must be 2MB or smaller.');
    }

    this.assertImageContentType(input.contentType);

    const now = Date.now();
    const extension = this.resolveImageExtension(input.fileName, input.contentType);
    const logicalBucket = 'organization-logos';
    const relativePath = `${orgId}/logo-${now}.${extension}`;
    const objectKey = `${logicalBucket}/${relativePath}`;

    const putCommand = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: objectKey,
      ContentType: input.contentType,
    });

    const uploadUrl = await getSignedUrl(this.s3, putCommand, { expiresIn: 15 * 60 });
    const publicUrl = this.buildPublicUrl(objectKey);

    return { uploadUrl, publicUrl, objectKey };
  }

  private resolveExtension(
    fileName: string,
    contentType: string,
    assetType: 'pitch_deck' | 'financial_doc' | 'legal_doc',
  ): string {
    if (contentType === 'application/pdf') return 'pdf';
    if (assetType === 'pitch_deck') {
      if (contentType === 'application/vnd.ms-powerpoint') return 'ppt';
      if (contentType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation')
        return 'pptx';
      if (contentType === 'video/mp4') return 'mp4';
      if (contentType === 'video/webm') return 'webm';
      if (contentType === 'video/quicktime') return 'mov';
    }

    if (contentType === 'application/msword') return 'doc';
    if (contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      return 'docx';
    if (contentType === 'application/vnd.ms-excel') return 'xls';
    if (contentType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      return 'xlsx';
    if (contentType === 'text/csv') return 'csv';

    const parts = fileName.split('.');
    const ext = parts.length > 1 ? parts.pop()?.trim().toLowerCase() : null;
    if (ext && /^[a-z0-9]+$/.test(ext)) {
      return ext;
    }

    return 'bin';
  }

  private resolveDataRoomExtension(
    fileName: string,
    contentType: string,
    documentType: StartupDataRoomDocumentType,
  ): string {
    if (documentType === 'pitch_deck') {
      return this.resolveExtension(fileName, contentType, 'pitch_deck');
    }

    return this.resolveExtension(fileName, contentType, 'financial_doc');
  }

  private resolveImageExtension(fileName: string, contentType: string): string {
    if (contentType === 'image/jpeg') return 'jpg';
    if (contentType === 'image/png') return 'png';
    if (contentType === 'image/webp') return 'webp';
    if (contentType === 'image/gif') return 'gif';
    if (contentType === 'image/svg+xml') return 'svg';

    const parts = fileName.split('.');
    const ext = parts.length > 1 ? parts.pop()?.trim().toLowerCase() : null;
    if (ext && /^[a-z0-9]+$/.test(ext)) {
      return ext;
    }

    return 'png';
  }
}
