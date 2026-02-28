import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class StartupMutationResult {
  success!: boolean;

  message?: string | null;

  postId?: string | null;
}

export type StartupReadinessView = {
  startup_org_id: string;
  has_startup_post: boolean;
  has_pitch_deck: boolean;
  has_team_info: boolean;
  has_financial_doc: boolean;
  has_legal_doc: boolean;
  profile_completion_percent: number;
  readiness_score: number;
  required_docs_uploaded: boolean;
  eligible_for_discovery_post: boolean;
  is_ready: boolean;
  missing_steps: string[];
  section_scores: Array<{
    section: string;
    weight: number;
    completion_percent: number;
    score_contribution: number;
  }>;
};

export type StartupProfileView = {
  startup_org_id: string;
  website_url: string | null;
  pitch_deck_url: string | null;
  pitch_deck_media_kind: string | null;
  pitch_deck_file_name: string | null;
  pitch_deck_file_size_bytes: number | null;
  team_overview: string | null;
  company_stage: string | null;
  founding_year: number | null;
  team_size: number | null;
  target_market: string | null;
  business_model: string | null;
  traction_summary: string | null;
  financial_summary: string | null;
  legal_summary: string | null;
  financial_doc_url: string | null;
  financial_doc_file_name: string | null;
  financial_doc_file_size_bytes: number | null;
  legal_doc_url: string | null;
  legal_doc_file_name: string | null;
  legal_doc_file_size_bytes: number | null;
  updated_at: string | null;
};

export type StartupPostView = {
  id: string;
  startup_org_id: string;
  title: string;
  summary: string;
  stage: string | null;
  location: string | null;
  industry_tags: string[];
  status: string;
  published_at: string | null;
  updated_at: string;
};

export class UpdateStartupProfileInput {
  @IsOptional()
  @IsUrl({ require_protocol: true })
  websiteUrl?: string | null;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  pitchDeckUrl?: string | null;

  @IsOptional()
  @IsIn(['document', 'video'])
  pitchDeckMediaKind?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  pitchDeckFileName?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50 * 1024 * 1024)
  pitchDeckFileSizeBytes?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  teamOverview?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  companyStage?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1900)
  @Max(2100)
  foundingYear?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000000)
  teamSize?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  targetMarket?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  businessModel?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  tractionSummary?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  financialSummary?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  legalSummary?: string | null;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  financialDocUrl?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  financialDocFileName?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50 * 1024 * 1024)
  financialDocFileSizeBytes?: number | null;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  legalDocUrl?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  legalDocFileName?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50 * 1024 * 1024)
  legalDocFileSizeBytes?: number | null;
}

export class UpdateStartupPostInput {
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  title!: string;

  @IsString()
  @MinLength(20)
  @MaxLength(1000)
  summary!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  stage?: string | null;

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

  @IsIn(['draft', 'published'])
  status!: string;
}
