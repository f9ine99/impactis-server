/* eslint-disable no-console */
/**
 * Discovery seed: 4 startups, 3 investors, 3 advisors (10 cards with images).
 * Run: npm run db:seed:demo (from impactis-server, DATABASE_URL in .env.local).
 * Idempotent: uses deterministic IDs so re-run updates existing rows.
 */

const dotenv = require("dotenv");
dotenv.config({ path: ".env.local" });

const crypto = require("crypto");
const { Pool } = require("pg");

const SEED_NS = "impactis-discovery-v1";

function uuid() {
  return crypto.randomUUID();
}

function seedId(name) {
  const hex = crypto.createHash("sha256").update(SEED_NS + name).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

async function main() {
  const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set. Add it to impactis-server/.env.local before running the seed.",
    );
  }
  const pool = new Pool({ connectionString: databaseUrl });
  pool.on("connect", (client) => {
    // Ensure we can access both public + auth schemas consistently.
    client.query("SET search_path TO public, auth");
  });

  const now = new Date();

  // Helper: professional card image (consistent per name)
  function logoUrl(name) {
    return `https://ui-avatars.com/api/?name=${encodeURIComponent(name.replace(/\s+/g, "+"))}&size=400&background=0D9488&color=fff&bold=true`;
  }

  // Seed startups for Discovery (4 total).
  const startups = [
    {
      name: "EcoPulse Energy",
      location: "Nairobi, KE",
      industry_tags: ["climate", "energy", "infrastructure"],
      logo_url: logoUrl("EcoPulse Energy"),
      post: {
        title: "Grid-edge storage for emerging markets",
        summary:
          "Modular battery + AI dispatch that stabilizes microgrids and lowers cost for SMEs.",
        stage: "Seed",
        location: "Nairobi, KE",
        industry_tags: ["climate", "energy"],
        need_advisor: true,
      },
      profile: {
        website_url: "https://example.com/ecopulse",
        team_overview: "Hardware + ML team with prior microgrid deployments.",
        company_stage: "Seed",
        founding_year: 2023,
        team_size: 9,
        target_market: "SMEs on microgrids + rural electrification providers",
        business_model: "Lease-to-own + revenue share on savings",
        traction_summary: "3 pilots live, $120k ARR signed LOIs.",
      },
      docs: [
        {
          document_type: "pitch_deck",
          title: "Pitch Deck",
          file_url: "https://example.com/ecopulse/pitch-deck.pdf",
          file_name: "ecopulse-pitch-deck.pdf",
          content_type: "application/pdf",
          file_size_bytes: BigInt(250_000),
          summary: "Problem, solution, market, traction, and fundraising.",
        },
      ],
    },
    {
      name: "CareBridge Clinics",
      location: "Austin, TX",
      industry_tags: ["health", "services", "ops"],
      logo_url: logoUrl("CareBridge Clinics"),
      post: {
        title: "Clinics-in-a-box for preventive care",
        summary:
          "Pop-up clinics integrated with employer benefits to expand preventive screening access.",
        stage: "Pre-Seed",
        location: "Austin, TX",
        industry_tags: ["health"],
        need_advisor: false,
      },
      profile: {
        website_url: "https://example.com/carebridge",
        team_overview: "Operators from urgent care chains + product lead from healthtech.",
        company_stage: "Pre-Seed",
        founding_year: 2024,
        team_size: 5,
        target_market: "Employers (500-5k employees) + local health systems",
        business_model: "Per-member-per-month + service fees",
        traction_summary: "2 employer pilots, 800 members enrolled.",
      },
      docs: [
        {
          document_type: "pitch_deck",
          title: "Pitch Deck",
          file_url: "https://example.com/carebridge/pitch-deck.pdf",
          file_name: "carebridge-pitch-deck.pdf",
          content_type: "application/pdf",
          file_size_bytes: BigInt(220_000),
          summary: "Go-to-market plan and unit economics.",
        },
      ],
    },
    {
      name: "LoopLedger",
      location: "Berlin, DE",
      industry_tags: ["fintech", "b2b", "saas"],
      logo_url: logoUrl("LoopLedger"),
      post: {
        title: "Automated carbon accounting for SMBs",
        summary:
          "Connects to invoices and banking to produce audit-ready carbon reports in days.",
        stage: "Seed",
        location: "Berlin, DE",
        industry_tags: ["fintech", "climate"],
        need_advisor: true,
      },
      profile: {
        website_url: "https://example.com/loopledger",
        team_overview: "Ex-auditors + engineers from accounting software companies.",
        company_stage: "Seed",
        founding_year: 2022,
        team_size: 12,
        target_market: "EU SMBs needing CSRD-aligned reporting",
        business_model: "SaaS subscription + implementation",
        traction_summary: "45 paying customers, 12% MoM growth.",
      },
      docs: [
        {
          document_type: "pitch_deck",
          title: "Pitch Deck",
          file_url: "https://example.com/loopledger/pitch-deck.pdf",
          file_name: "loopledger-pitch-deck.pdf",
          content_type: "application/pdf",
          file_size_bytes: BigInt(260_000),
          summary: "Market sizing, product demo, and metrics.",
        },
      ],
    },
    {
      name: "Nexus AI",
      location: "San Francisco, CA",
      industry_tags: ["ai", "saas", "enterprise"],
      logo_url: logoUrl("Nexus AI"),
      post: {
        title: "AI-powered workflow automation for legal teams",
        summary:
          "Contract analysis and clause extraction that cuts review time by 60% for mid-market law firms.",
        stage: "Series A",
        location: "San Francisco, CA",
        industry_tags: ["ai", "legal-tech", "saas"],
        need_advisor: true,
      },
      profile: {
        website_url: "https://example.com/nexusai",
        team_overview: "Ex-BigLaw + ML engineers from FAANG.",
        company_stage: "Series A",
        founding_year: 2021,
        team_size: 28,
        target_market: "Law firms 50-500 attorneys",
        business_model: "SaaS per-seat + implementation",
        traction_summary: "120+ firms, $2.1M ARR, 18% MoM.",
      },
      docs: [
        {
          document_type: "pitch_deck",
          title: "Pitch Deck",
          file_url: "https://example.com/nexusai/pitch.pdf",
          file_name: "nexusai-pitch.pdf",
          content_type: "application/pdf",
          file_size_bytes: BigInt(280_000),
          summary: "Market, product, and growth metrics.",
        },
      ],
    },
  ];

  const createdStartupOrgIds = [];

  const hasNeedAdvisor = (
    await pool.query(
      `
      select exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'startup_posts'
          and column_name = 'need_advisor'
      ) as ok
      `,
    )
  ).rows?.[0]?.ok === true;

  if (!hasNeedAdvisor) {
    console.warn(
      "Warning: public.startup_posts.need_advisor is missing. Run prisma/migrations/manual_add_connections_need_advisor.sql first to fully enable advisor recommendations.",
    );
  }

  for (const s of startups) {
    const orgId = seedId("startup-" + s.name);
    createdStartupOrgIds.push(orgId);
    await pool.query(
      `
      insert into public.organizations (id, type, name, location, industry_tags, logo_url)
      values ($1::uuid, 'startup'::public.org_type, $2, $3, $4::text[], $5)
      on conflict (id) do update set
        name = excluded.name,
        location = excluded.location,
        industry_tags = excluded.industry_tags,
        logo_url = excluded.logo_url
      `,
      [orgId, s.name, s.location, s.industry_tags, s.logo_url],
    );

    await pool.query(
      `
      insert into public.org_status (org_id, status)
      values ($1::uuid, 'active'::public.org_lifecycle_status)
      on conflict (org_id) do update set status = 'active'::public.org_lifecycle_status, updated_at = timezone('utc', now())
      `,
      [orgId],
    );

    if (hasNeedAdvisor) {
      await pool.query(
        `
        insert into public.startup_posts (
          startup_org_id, title, summary, stage, location, industry_tags,
          status, published_at, need_advisor
        )
        values (
          $1::uuid, $2, $3, $4, $5, $6::text[],
          'published'::public.startup_post_status, $7::timestamptz, $8::boolean
        )
        on conflict (startup_org_id) do update set
          title = excluded.title,
          summary = excluded.summary,
          stage = excluded.stage,
          location = excluded.location,
          industry_tags = excluded.industry_tags,
          status = excluded.status,
          published_at = excluded.published_at,
          need_advisor = excluded.need_advisor
        `,
        [
          orgId,
          s.post.title,
          s.post.summary,
          s.post.stage,
          s.post.location,
          s.post.industry_tags,
          now.toISOString(),
          s.post.need_advisor,
        ],
      );
    } else {
      await pool.query(
        `
        insert into public.startup_posts (
          startup_org_id, title, summary, stage, location, industry_tags,
          status, published_at
        )
        values (
          $1::uuid, $2, $3, $4, $5, $6::text[],
          'published'::public.startup_post_status, $7::timestamptz
        )
        on conflict (startup_org_id) do update set
          title = excluded.title,
          summary = excluded.summary,
          stage = excluded.stage,
          location = excluded.location,
          industry_tags = excluded.industry_tags,
          status = excluded.status,
          published_at = excluded.published_at
        `,
        [
          orgId,
          s.post.title,
          s.post.summary,
          s.post.stage,
          s.post.location,
          s.post.industry_tags,
          now.toISOString(),
        ],
      );
    }

    await pool.query(
      `
      insert into public.startup_profiles (
        startup_org_id,
        website_url,
        team_overview,
        company_stage,
        founding_year,
        team_size,
        target_market,
        business_model,
        traction_summary
      )
      values ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9)
      on conflict (startup_org_id) do update set
        website_url = excluded.website_url,
        team_overview = excluded.team_overview,
        company_stage = excluded.company_stage,
        founding_year = excluded.founding_year,
        team_size = excluded.team_size,
        target_market = excluded.target_market,
        business_model = excluded.business_model,
        traction_summary = excluded.traction_summary
      `,
      [
        orgId,
        s.profile.website_url,
        s.profile.team_overview,
        s.profile.company_stage,
        s.profile.founding_year,
        s.profile.team_size,
        s.profile.target_market,
        s.profile.business_model,
        s.profile.traction_summary,
      ],
    );

    for (const d of s.docs) {
      await pool.query(
        `
        insert into public.startup_data_room_documents (
          startup_org_id,
          document_type,
          title,
          file_url,
          file_name,
          file_size_bytes,
          content_type,
          summary
        )
        values (
          $1::uuid,
          $2::public.startup_data_room_document_type,
          $3,
          $4,
          $5,
          $6::bigint,
          $7,
          $8
        )
        on conflict (startup_org_id, document_type) do update set
          title = excluded.title,
          file_url = excluded.file_url,
          file_name = excluded.file_name,
          file_size_bytes = excluded.file_size_bytes,
          content_type = excluded.content_type,
          summary = excluded.summary
        `,
        [
          orgId,
          d.document_type,
          d.title,
          d.file_url,
          d.file_name,
          d.file_size_bytes.toString(),
          d.content_type,
          d.summary,
        ],
      );
    }
  }

  // Seed investors for Discovery (3 total).
  const investors = [
    {
      name: "GreenVentures Capital",
      location: "London, UK",
      industry_tags: ["climate", "energy", "impact"],
      logo_url: logoUrl("GreenVentures Capital"),
      profile: {
        website_url: "https://example.com/greenventures",
        thesis: "Seed to Series A in climate tech and energy transition. We back technical founders with clear path to decarbonization.",
        stage_focus: ["seed", "series-a"],
        sector_tags: ["climate", "energy", "mobility", "agtech"],
        check_size_min_usd: 500_000,
        check_size_max_usd: 3_000_000,
      },
    },
    {
      name: "HealthEdge Partners",
      location: "Boston, MA",
      industry_tags: ["health", "biotech", "digital-health"],
      logo_url: logoUrl("HealthEdge Partners"),
      profile: {
        website_url: "https://example.com/healthedge",
        thesis: "Early-stage digital health and care delivery. Focus on outcomes-based models and underserved populations.",
        stage_focus: ["pre-seed", "seed"],
        sector_tags: ["health", "care-delivery", "mental-health", "diagnostics"],
        check_size_min_usd: 250_000,
        check_size_max_usd: 1_500_000,
      },
    },
    {
      name: "SaaS Growth Fund",
      location: "New York, NY",
      industry_tags: ["saas", "b2b", "fintech"],
      logo_url: logoUrl("SaaS Growth Fund"),
      profile: {
        website_url: "https://example.com/saasgrowth",
        thesis: "B2B SaaS with $1M+ ARR and strong NRR. We lead Series A/B and help with go-to-market and international expansion.",
        stage_focus: ["series-a", "series-b"],
        sector_tags: ["saas", "fintech", "enterprise", "devtools"],
        check_size_min_usd: 2_000_000,
        check_size_max_usd: 10_000_000,
      },
    },
  ];

  for (const inv of investors) {
    const orgId = seedId("investor-" + inv.name);
    await pool.query(
      `
      insert into public.organizations (id, type, name, location, industry_tags, logo_url)
      values ($1::uuid, 'investor'::public.org_type, $2, $3, $4::text[], $5)
      on conflict (id) do update set
        name = excluded.name,
        location = excluded.location,
        industry_tags = excluded.industry_tags,
        logo_url = excluded.logo_url
      `,
      [orgId, inv.name, inv.location, inv.industry_tags, inv.logo_url],
    );
    await pool.query(
      `insert into public.org_status (org_id, status) values ($1::uuid, 'active'::public.org_lifecycle_status) on conflict (org_id) do update set status = 'active'::public.org_lifecycle_status, updated_at = timezone('utc', now())`,
      [orgId],
    );
    await pool.query(
      `
      insert into public.investor_profiles (
        investor_org_id, website_url, thesis, stage_focus, sector_tags,
        check_size_min_usd, check_size_max_usd
      )
      values ($1::uuid, $2, $3, $4::text[], $5::text[], $6::bigint, $7::bigint)
      on conflict (investor_org_id) do update set
        website_url = excluded.website_url,
        thesis = excluded.thesis,
        stage_focus = excluded.stage_focus,
        sector_tags = excluded.sector_tags,
        check_size_min_usd = excluded.check_size_min_usd,
        check_size_max_usd = excluded.check_size_max_usd
      `,
      [
        orgId,
        inv.profile.website_url,
        inv.profile.thesis,
        inv.profile.stage_focus,
        inv.profile.sector_tags,
        String(inv.profile.check_size_min_usd),
        String(inv.profile.check_size_max_usd),
      ],
    );
  }

  // Seed advisors for Discovery (3 total).
  const advisors = [
    {
      name: "Maria Chen Advisory",
      location: "Singapore",
      industry_tags: ["go-to-market", "asia-expansion", "saas"],
      logo_url: logoUrl("Maria Chen"),
      profile: {
        website_url: "https://example.com/mariachen",
        linkedin_url: "https://linkedin.com/in/mariachen",
        bio: "Ex-CMO at two unicorn SaaS companies. Advise on GTM, positioning, and Asia expansion. 15+ years in B2B.",
        expertise_tags: ["go-to-market", "positioning", "asia-expansion", "saas"],
        years_experience: 15,
      },
    },
    {
      name: "David Okonkwo Ventures",
      location: "Lagos, NG",
      industry_tags: ["fintech", "emerging-markets", "regulation"],
      logo_url: logoUrl("David Okonkwo"),
      profile: {
        website_url: "https://example.com/davidokonkwo",
        linkedin_url: "https://linkedin.com/in/davidokonkwo",
        bio: "Fintech and regulatory strategy for Africa. Former regulator and founder of a payments startup.",
        expertise_tags: ["fintech", "regulation", "emerging-markets", "payments"],
        years_experience: 12,
      },
    },
    {
      name: "Sarah Mitchell & Co",
      location: "Austin, TX",
      industry_tags: ["health", "operations", "scale"],
      logo_url: logoUrl("Sarah Mitchell"),
      profile: {
        website_url: "https://example.com/sarahmitchell",
        linkedin_url: "https://linkedin.com/in/sarahmitchell",
        bio: "Healthcare operations and scaling. COO experience at two healthtech scale-ups. Focus on unit economics and care quality.",
        expertise_tags: ["healthcare-ops", "scaling", "unit-economics", "care-delivery"],
        years_experience: 18,
      },
    },
  ];

  for (const adv of advisors) {
    const orgId = seedId("advisor-" + adv.name);
    await pool.query(
      `
      insert into public.organizations (id, type, name, location, industry_tags, logo_url)
      values ($1::uuid, 'advisor'::public.org_type, $2, $3, $4::text[], $5)
      on conflict (id) do update set
        name = excluded.name,
        location = excluded.location,
        industry_tags = excluded.industry_tags,
        logo_url = excluded.logo_url
      `,
      [orgId, adv.name, adv.location, adv.industry_tags, adv.logo_url],
    );
    await pool.query(
      `insert into public.org_status (org_id, status) values ($1::uuid, 'active'::public.org_lifecycle_status) on conflict (org_id) do update set status = 'active'::public.org_lifecycle_status, updated_at = timezone('utc', now())`,
      [orgId],
    );
    await pool.query(
      `
      insert into public.advisor_profiles (
        advisor_org_id, website_url, linkedin_url, bio, expertise_tags, years_experience
      )
      values ($1::uuid, $2, $3, $4, $5::text[], $6)
      on conflict (advisor_org_id) do update set
        website_url = excluded.website_url,
        linkedin_url = excluded.linkedin_url,
        bio = excluded.bio,
        expertise_tags = excluded.expertise_tags,
        years_experience = excluded.years_experience
      `,
      [
        orgId,
        adv.profile.website_url,
        adv.profile.linkedin_url,
        adv.profile.bio,
        adv.profile.expertise_tags,
        adv.profile.years_experience,
      ],
    );
  }

  console.log("Discovery seed done: 4 startups, 3 investors, 3 advisors (10 cards with images).");
  console.log("Workspace > Discovery will show them. Re-run this script anytime to refresh seed data.");

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

