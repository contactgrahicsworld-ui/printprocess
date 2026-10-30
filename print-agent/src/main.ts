import { main } from './cli.js';

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`ERROR: ${(e as Error).message ?? String(e)}`);
    process.exit(1);
  },
);
