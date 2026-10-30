import next from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const config = [
  ...next,
  ...nextTs,
  { ignores: [".next/**", "node_modules/**", "public/**", "playwright-report/**", "test-results/**", "next-env.d.ts"] },
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      // Our effects fetch data on mount and set state after an awaited request (the documented
      // "fetch in effect" pattern); the compiler rule cannot see the await boundary.
      "react-hooks/set-state-in-effect": "off",
    },
  },
  // Tests read loosely-typed JSON responses.
  { files: ["tests/**/*.ts", "e2e/**/*.ts"], rules: { "@typescript-eslint/no-explicit-any": "off" } },
];
export default config;
