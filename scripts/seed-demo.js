/* eslint-disable no-console */

const dotenv = require("dotenv");
dotenv.config({ path: ".env.local" });

const crypto = require("crypto");
const { Pool } = require("pg");

function uuid() {
  return crypto.randomUUID();
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

  // Seed startups for Discovery Room.
  const startups = [
    {
      name: "EcoPulse Energy",
      location: "Nairobi, KE",
      industry_tags: ["climate", "energy", "infrastructure"],
      logo_url: null,
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
      logo_url: null,
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
      logo_url: null,
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
    const orgId = uuid();
    createdStartupOrgIds.push(orgId);
    await pool.query(
      `
      insert into public.organizations (id, type, name, location, industry_tags, logo_url)
      values ($1::uuid, $2::public.org_type, $3, $4, $5::text[], $6)
      on conflict (id) do nothing
      `,
      [orgId, "startup", s.name, s.location, s.industry_tags, s.logo_url],
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

  console.log("Seeded discovery startups:", createdStartupOrgIds.length);
  console.log("You can now test: /workspace/discovery and open startup profiles.");

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

