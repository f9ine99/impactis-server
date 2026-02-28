import {
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class ProfileMutationResult {
  success!: boolean;

  message?: string | null;
}

export class UpdateProfileInput {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  fullName?: string | null;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  location?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  bio?: string | null;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  avatarUrl?: string | null;

  @IsOptional()
  @IsString()
  @Matches(/^\+[1-9][0-9]{7,14}$/)
  phone?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  headline?: string | null;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  websiteUrl?: string | null;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  @Matches(/^https?:\/\/([a-z0-9-]+\.)?linkedin\.com(\/|$)/i)
  linkedinUrl?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  timezoneName?: string | null;

  @IsOptional()
  @IsIn(['email', 'phone', 'linkedin'])
  preferredContactMethod?: string | null;
}
