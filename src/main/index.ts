/**
 * SJS Desktop App — Main entry point
 *
 * For now this is a CLI app. Electron tray UI can be added later.
 * Run with: npx tsx src/main/index.ts
 */

import { loadConfig, saveConfig, type AppConfig } from "./config";
import { connect, disconnect, getStatus } from "./tunnel-client";
import readline from "readline";

async function main(): Promise<void> {
  console.log("===========================================");
  console.log("  Smart Job Seeker — Desktop App v0.1.0");
  console.log("===========================================\n");

  const config = loadConfig();

  // Check if configured
  if (!config.serverUrl || !config.apiToken) {
    console.log("First-time setup required.\n");

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const ask = (question: string): Promise<string> =>
      new Promise((resolve) => rl.question(question, resolve));

    config.serverUrl = await ask("Server tunnel URL (e.g., wss://smartjobseeker.com/tunnel): ");
    config.apiToken = await ask("API token (from your SJS dashboard): ");

    const headedAnswer = (await ask("Show browser window? (Y/n): ")).toLowerCase();
    config.headed = headedAnswer !== "n";

    rl.close();

    saveConfig(config);
    console.log("\nConfiguration saved.\n");
  }

  console.log(`Server: ${config.serverUrl}`);
  console.log(`Token: ${config.apiToken.substring(0, 8)}...`);
  console.log(`Headed: ${config.headed}`);
  console.log();

  // Connect to the tunnel
  connect(config, {
    onStatusChange: (status) => {
      // Status already logged by tunnel-client
    },
    onError: (error) => {
      console.error(`\nError: ${error}\n`);
    },
  });

  // Handle graceful shutdown
  const shutdown = () => {
    console.log("\nShutting down...");
    disconnect();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep the process alive
  console.log("Press Ctrl+C to stop.\n");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
