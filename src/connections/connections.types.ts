import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class CreateConnectionRequestInput {
  @IsUUID()
  toOrgId!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  message?: string | null;
}

export type ConnectionRequestView = {
  id: string;
  from_org_id: string;
  from_org_name: string;
  to_org_id: string;
  to_org_name: string;
  status: 'pending' | 'accepted' | 'rejected';
  message: string | null;
  created_at: string;
  responded_at: string | null;
};

export type ConnectionView = {
  id: string;
  org_a_id: string;
  org_b_id: string;
  other_org_id: string;
  other_org_name: string;
  created_at: string;
};

export type ConnectionMessageView = {
  id: string;
  connection_id: string;
  from_org_id: string;
  from_org_name: string;
  body: string;
  created_at: string;
};
