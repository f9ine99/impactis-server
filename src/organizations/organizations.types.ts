import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
} from 'class-validator';

export class MutationResult {
  success!: boolean;

  message?: string | null;

  orgId?: string | null;
}

export class CreateOrganizationInvitePayload extends MutationResult {
  inviteId?: string | null;

  inviteToken?: string | null;
}

export type OrganizationIncomingInviteView = {
  id: string;
  org_id: string;
  organization_name: string;
  organization_type: string;
  member_role: string;
  invited_email: string;
  invited_by: string;
  expires_at: string;
  created_at: string;
};

export type OrganizationView = {
  id: string;
  type: 'startup' | 'advisor' | 'investor';
  name: string;
  location: string | null;
  logo_url: string | null;
  industry_tags: string[];
  created_at: string;
};

export type OrganizationMembershipView = {
  org_id: string;
  user_id: string;
  member_role: 'owner' | 'admin' | 'member';
  status: 'pending' | 'active' | 'left' | 'removed' | 'expired' | 'cancelled';
  created_at: string;
  organization: OrganizationView;
};

export type OrganizationMembershipExistsView = {
  hasMembership: boolean;
};

export type OrganizationVerificationView = {
  org_id: string;
  status: 'unverified' | 'pending' | 'approved' | 'rejected';
  reviewed_by: string | null;
  reviewed_at: string | null;
  notes: string | null;
};

export type OrganizationVerificationOverviewView = {
  organization: OrganizationView;
  verification: OrganizationVerificationView;
};

export type OrganizationOutgoingInviteView = {
  id: string;
  org_id: string;
  invited_email: string;
  member_role: 'owner' | 'admin' | 'member';
  status: 'pending' | 'accepted' | 'expired' | 'cancelled' | 'revoked';
  invited_by: string;
  accepted_by: string | null;
  expires_at: string;
  created_at: string;
  responded_at: string | null;
};

export type OrganizationMemberDirectoryEntryView = {
  user_id: string;
  member_role: 'owner' | 'admin' | 'member';
  status: 'pending' | 'active' | 'left' | 'removed' | 'expired' | 'cancelled';
  joined_at: string | null;
  full_name: string | null;
  avatar_url: string | null;
  location: string | null;
};

export class UpdateOrganizationIdentityInput {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  location?: string | null;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  logoUrl?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MinLength(2, { each: true })
  @MaxLength(48, { each: true })
  industryTags?: string[] | null;
}

export class CreateOrganizationWithOwnerInput {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsIn(['startup', 'advisor', 'investor'])
  type!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  location?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MinLength(2, { each: true })
  @MaxLength(48, { each: true })
  industryTags?: string[] | null;
}

export class CreateOrganizationInviteInput {
  @IsEmail()
  invitedEmail!: string;

  @IsOptional()
  @IsIn(['admin', 'member'])
  memberRole?: string | null;

  @IsOptional()
  @IsISO8601()
  expiresAt?: string | null;
}

export class UpdateOrganizationVerificationInput {
  @IsIn(['unverified', 'pending', 'approved', 'rejected'])
  status!: 'unverified' | 'pending' | 'approved' | 'rejected';

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string | null;
}
