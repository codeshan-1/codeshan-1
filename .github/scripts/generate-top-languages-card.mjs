import fs from "node:fs/promises";
import path from "node:path";

const token = process.env.GH_STATS_TOKEN || process.env.GITHUB_TOKEN;

if (!token) {
  throw new Error("Missing GH_STATS_TOKEN or GITHUB_TOKEN.");
}

const GRAPHQL_URL = "https://api.github.com/graphql";

async function gql(query, variables) {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "codeshan-top-languages-card",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`GitHub GraphQL request failed: ${res.status}`);
  }

  const data = await res.json();
  if (data.errors) {
    throw new Error(`GitHub GraphQL errors: ${JSON.stringify(data.errors)}`);
  }

  return data.data;
}

function pct(value, total) {
  if (!total) return 0;
  return (value / total) * 100;
}

function esc(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function collectLanguages() {
  const query = `
    query RepoLanguages($cursor: String) {
      viewer {
        repositories(
          first: 100
          after: $cursor
          ownerAffiliations: OWNER
          isFork: false
          orderBy: { field: PUSHED_AT, direction: DESC }
        ) {
          nodes {
            isPrivate
            languages(first: 20, orderBy: { field: SIZE, direction: DESC }) {
              edges {
                size
                node {
                  name
                }
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  `;

  const byLanguage = new Map();
  let privateRepos = 0;
  let publicRepos = 0;
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const data = await gql(query, { cursor });
    const repos = data.viewer.repositories.nodes || [];

    for (const repo of repos) {
      if (repo.isPrivate) privateRepos += 1;
      else publicRepos += 1;

      const edges = repo.languages?.edges || [];
      for (const edge of edges) {
        const name = edge.node?.name;
        const size = edge.size || 0;
        if (!name || size <= 0) continue;
        byLanguage.set(name, (byLanguage.get(name) || 0) + size);
      }
    }

    hasNextPage = data.viewer.repositories.pageInfo.hasNextPage;
    cursor = data.viewer.repositories.pageInfo.endCursor;
  }

  return { byLanguage, privateRepos, publicRepos };
}

function buildSvg(topItems, totalBytes, privateRepos, publicRepos) {
  const width = 640;
  const height = 360;
  const labelX = 22;
  const barX = 206;
  const barW = 360;
  const barH = 18;
  const rowGap = 44;
  const rowsCount = topItems.length;
  const contentStartY = 112;
  const contentEndY = height - 24;
  const rowsBlockHeight = rowsCount > 0 ? ((rowsCount - 1) * rowGap + barH) : 0;
  const firstY = Math.round(contentStartY + Math.max(0, (contentEndY - contentStartY - rowsBlockHeight) / 2));

  const rows = topItems
    .map((item, idx) => {
      const percent = pct(item.bytes, totalBytes);
      const fillW = Math.max(2, Math.round((barW * percent) / 100));
      const y = firstY + idx * rowGap;
      const p = percent.toFixed(1);
      return `
  <text x="${labelX}" y="${y + 14}" fill="#E6F7FF" font-size="24" font-family="Segoe UI, Arial" font-weight="700">${esc(item.name)}</text>
  <text x="${barX + barW + 12}" y="${y + 14}" fill="#C9D1D9" font-size="17" font-family="Segoe UI, Arial" font-weight="700">${p}%</text>
  <rect x="${barX}" y="${y}" width="${barW}" height="${barH}" rx="8" fill="#111a2a" />
  <rect x="${barX}" y="${y}" width="${fillW}" height="${barH}" rx="8" fill="url(#neonBar)" />`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Top Languages">
  <defs>
    <linearGradient id="cardBg" x1="0" y1="0" x2="640" y2="360" gradientUnits="userSpaceOnUse">
      <stop stop-color="#0D1117"/>
      <stop offset="1" stop-color="#0F1726"/>
    </linearGradient>
    <linearGradient id="neonBar" x1="206" y1="0" x2="566" y2="0" gradientUnits="userSpaceOnUse">
      <stop stop-color="#1EB8E4"/>
      <stop offset="1" stop-color="#22D3EE"/>
    </linearGradient>
    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="3.5" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>

  <rect x="1" y="1" width="638" height="358" rx="16" fill="url(#cardBg)" stroke="#1EB8E4" stroke-width="2"/>

  <text x="22" y="46" fill="#22D3EE" font-size="32" font-family="Segoe UI, Arial" font-weight="700" filter="url(#glow)">Top Languages (All Repos)</text>
  <text x="22" y="74" fill="#8B949E" font-size="17" font-family="Segoe UI, Arial">Public: ${publicRepos} | Private: ${privateRepos}</text>

${rows}
</svg>`;
}

async function main() {
  const { byLanguage, privateRepos, publicRepos } = await collectLanguages();
  const sorted = [...byLanguage.entries()]
    .map(([name, bytes]) => ({ name, bytes }))
    .sort((a, b) => b.bytes - a.bytes);

  const topItems = sorted.slice(0, 5);
  const totalBytes = sorted.reduce((sum, item) => sum + item.bytes, 0);

  const svg = buildSvg(topItems, totalBytes, privateRepos, publicRepos);
  const outDir = path.resolve("dist");
  const outFile = path.join(outDir, "top-languages-neon.svg");

  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(outFile, svg, "utf8");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
