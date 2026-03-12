export type WorkspaceSnapshot = {
  verification_status: string;
  current_plan: WorkspaceCurrentPlanSnapshot | null;
  advisor_directory: Array<{
    id: string;
    name: string;
    location: string | null;
    industry_tags: string[];
    verification_status: string;
  }>;
  startup_readiness: {
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
  } | null;
};

export type WorkspaceCurrentPlanSnapshot = {
  org_id: string;
  org_type: 'startup' | 'investor' | 'advisor';
  plan: {
    id: string;
    code: string;
    name: string;
    tier: number;
    currency: string;
    monthly_price_cents: number | null;
    annual_price_cents: number | null;
  };
  subscription: {
    id: string | null;
    status: 'trialing' | 'active' | 'past_due' | 'paused' | 'canceled' | 'incomplete' | null;
    billing_interval: 'monthly' | 'annual' | null;
    started_at: string | null;
    current_period_start: string | null;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
    canceled_at: string | null;
    is_fallback_free: boolean;
  };
};

export type WorkspaceOrganizationReadinessSnapshot = {
  org_id: string;
  org_type: 'startup' | 'advisor' | 'investor';
  readiness_score: number;
  is_ready: boolean;
  missing_steps: string[];
  rules_version: string;
  computed_at: string | null;
};

export type WorkspaceStartupDiscoveryFeedItem = {
  id: string;
  startup_org_id: string;
  startup_org_name: string;
  title: string;
  summary: string;
  stage: string | null;
  location: string | null;
  industry_tags: string[];
  published_at: string | null;
  startup_verification_status: 'unverified' | 'pending' | 'approved' | 'rejected';
  need_advisor: boolean;
};

export type WorkspaceIdentitySnapshot = {
  profile: {
    id: string;
    full_name: string | null;
    location: string | null;
    bio: string | null;
    avatar_url: string | null;
    phone: string | null;
    headline: string | null;
    website_url: string | null;
    linkedin_url: string | null;
    timezone_name: string | null;
    preferred_contact_method: 'email' | 'phone' | 'linkedin' | null;
  };
  membership: {
    org_id: string;
    user_id: string;
    member_role: 'owner' | 'admin' | 'member';
    status: 'pending' | 'active' | 'left' | 'removed' | 'expired' | 'cancelled';
    created_at: string;
    organization: {
      id: string;
      type: 'startup' | 'investor' | 'advisor';
      name: string;
      location: string | null;
      logo_url: string | null;
      industry_tags: string[];
      created_at: string;
    };
  } | null;
};

export type WorkspaceCoreTeamMember = {
  user_id: string;
  member_role: 'owner' | 'admin' | 'member';
  status: 'pending' | 'active' | 'left' | 'removed' | 'expired' | 'cancelled';
  joined_at: string | null;
  full_name: string | null;
  avatar_url: string | null;
  location: string | null;
};

export type WorkspaceSettingsSnapshot = {
  verification_status: string;
  current_plan: WorkspaceCurrentPlanSnapshot | null;
  pending_invites_count: number;
  pending_invites: Array<{
    id: string;
    org_id: string;
    invited_email: string;
    member_role: string;
    status: string;
    invited_by: string;
    accepted_by: string | null;
    expires_at: string;
    created_at: string;
    responded_at: string | null;
  }>;
  startup_profile: {
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
  } | null;
  startup_post: {
    id: string;
    startup_org_id: string;
    title: string;
    summary: string;
    stage: string | null;
    location: string | null;
    industry_tags: string[];
    need_advisor: boolean;
    status: string;
    published_at: string | null;
    updated_at: string;
  } | null;
  startup_readiness: {
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
  } | null;
};

export type WorkspaceDashboardSnapshot = {
  verification_status: string;
  current_plan: WorkspaceCurrentPlanSnapshot | null;
  organization_core_team: WorkspaceCoreTeamMember[];
  organization_readiness: WorkspaceOrganizationReadinessSnapshot | null;
  startup_discovery_feed: WorkspaceStartupDiscoveryFeedItem[];
  startup_readiness: WorkspaceSettingsSnapshot['startup_readiness'];
};

export type WorkspaceBootstrapSnapshot = {
  profile: WorkspaceIdentitySnapshot['profile'];
  membership: WorkspaceIdentitySnapshot['membership'];
  verification_status: WorkspaceDashboardSnapshot['verification_status'];
  current_plan: WorkspaceCurrentPlanSnapshot | null;
  organization_core_team: WorkspaceDashboardSnapshot['organization_core_team'];
  organization_readiness: WorkspaceDashboardSnapshot['organization_readiness'];
  startup_discovery_feed: WorkspaceDashboardSnapshot['startup_discovery_feed'];
  startup_readiness: WorkspaceDashboardSnapshot['startup_readiness'];
};
