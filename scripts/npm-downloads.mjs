#!/usr/bin/env node

const packageName = process.argv[2] || "preflight-pro";
const ranges = ["last-day", "last-week", "last-month"];

async function getJson(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": "preflight-metrics" }
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${url}`);
  }

  return response.json();
}

const [pointStats, dailyStats] = await Promise.all([
  Promise.all(
    ranges.map(async (range) => {
      const data = await getJson(
        `https://api.npmjs.org/downloads/point/${range}/${packageName}`
      );
      return { range, ...data };
    })
  ),
  getJson(`https://api.npmjs.org/downloads/range/last-month/${packageName}`)
]);

console.log(`NPM downloads for ${packageName}`);
console.log("Note: npm reports package downloads, not unique users or installs.\n");

for (const stat of pointStats) {
  console.log(
    `${stat.range.padEnd(10)} ${String(stat.downloads).padStart(6)} downloads (${stat.start} to ${stat.end})`
  );
}

console.log("\nDaily downloads over the last month");
for (const item of dailyStats.downloads) {
  console.log(`${item.day} ${String(item.downloads).padStart(5)}`);
}
