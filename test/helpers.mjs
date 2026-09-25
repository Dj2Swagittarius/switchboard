// Every test runs against a throwaway data folder, never the real one.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.SWITCHBOARD_DATA?.includes('switchboard-test-'))
  process.env.SWITCHBOARD_DATA = mkdtempSync(join(tmpdir(), 'switchboard-test-'));
export const DATA = process.env.SWITCHBOARD_DATA;
