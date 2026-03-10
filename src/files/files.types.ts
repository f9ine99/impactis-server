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

export class CreateProfileAvatarUploadUrlInput {
  @IsString()
  @MaxLength(255)
  fileName!: string;

  @IsMimeType()
  contentType!: string;

  @IsInt()
  @Min(1)
  @Max(2 * 1024 * 1024)
  contentLength!: number;
}

export class CreateOrganizationLogoUploadUrlInput {
  @IsUUID()
  orgId!: string;

  @IsString()
  @MaxLength(255)
  fileName!: string;

  @IsMimeType()
  contentType!: string;

  @IsInt()
  @Min(1)
  @Max(2 * 1024 * 1024)
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

export const STARTUP_DATA_ROOM_DOCUMENT_TYPES = [
  'pitch_deck',
  'financial_doc',
  'legal_doc',
  'financial_model',
  'cap_table',
  'traction_metrics',
  'legal_company_docs',
  'incorporation_docs',
  'customer_contracts_summaries',
  'term_sheet_drafts',
] as const;

export type StartupDataRoomDocumentType = (typeof STARTUP_DATA_ROOM_DOCUMENT_TYPES)[number];

export class CreateStartupDataRoomUploadUrlInput {
  @IsUUID()
  orgId!: string;

  @IsIn(STARTUP_DATA_ROOM_DOCUMENT_TYPES)
  documentType!: StartupDataRoomDocumentType;

  @IsString()
  @MaxLength(255)
  fileName!: string;

  @IsMimeType()
  contentType!: string;

  @IsInt()
  @Min(1)
  @Max(100 * 1024 * 1024)
  contentLength!: number;
}
