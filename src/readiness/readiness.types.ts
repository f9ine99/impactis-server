export type StartupReadinessSectionScore = {
  section: string;
  weight: number;
  completion_percent: number;
  score_contribution: number;
};

export type StartupReadinessSnapshot = {
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
  section_scores: StartupReadinessSectionScore[];
};

export type OrganizationReadinessSummaryItem = {
  org_id: string;
  org_name: string;
  org_type: 'startup' | 'advisor' | 'investor';
  org_status: string;
  verification_status: string;
  readiness_score: number;
  is_ready: boolean;
  missing_steps: string[];
  rules_version: string;
  computed_at: string | null;
};

export type OrganizationReadinessSummaryResult = {
  items: OrganizationReadinessSummaryItem[];
  total: number;
  page: number;
  limit: number;
};
