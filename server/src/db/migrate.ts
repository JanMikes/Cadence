/** CLI: create/upgrade the app database at ~/.cadence/cadence.db. */
import { defaultDbPath, openAndMigrate } from "./client";

openAndMigrate();
console.log(`[cadence] database migrated at ${defaultDbPath()}`);
