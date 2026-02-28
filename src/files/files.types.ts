import { IsIn, IsInt, IsMimeType, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

export class StartupPitchDeckUploadUrlPayload {
  success!: boolean;

  message?: string | null;

  uploadUrl?: string | null;

  publicUrl?: string | null;

  objectKey?: string | null;
}

export class CreateStartupPitchDeckUploadUrlInput {
  @IsUUID()
  orgId!: string;

  @IsString()
  @MaxLength(255)
  fileName!: string;

  @IsMimeType()
  contentType!: string;

  @IsInt()
  @Min(1)
  @Max(50 * 1024 * 1024)
  contentLength!: number;
}

export class CreateStartupReadinessUploadUrlInput {
  @IsUUID()
  orgId!: string;

  @IsIn(['pitch_deck', 'financial_doc', 'legal_doc'])
  assetType!: 'pitch_deck' | 'financial_doc' | 'legal_doc';

  @IsString()
  @MaxLength(255)
  fileName!: string;

  @IsMimeType()
  contentType!: string;

  @IsInt()
  @Min(1)
  @Max(50 * 1024 * 1024)
  contentLength!: number;
}
