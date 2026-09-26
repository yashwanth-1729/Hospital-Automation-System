import "../src/lib/load-env";
import { closePool } from "../src/lib/db";
import { recentRetentionRuns, runRetention } from "../src/server/workflows/retention";

/** Runs the retention purge now: npx tsx scripts/retention.ts [--force] */
async function main() {
  const result = await runRetention({ force: process.argv.includes("--force") });
  if (result.skipped) {
    console.log("Retention has already run today (use --force to run again), or it is disabled.");
  } else {
    console.log(
      `Redacted ${result.messagesRedacted} message bodies, ${result.enquiriesCleared} enquiries and ${result.inboundCleared} replies.`,
    );
  }
  console.log("\nRecent runs:");
  for (const run of await recentRetentionRuns(5)) {
    console.log(`  ${run.ran_for_date}  messages=${run.messages_redacted} enquiries=${run.enquiries_cleared}`);
  }
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => closePool());
