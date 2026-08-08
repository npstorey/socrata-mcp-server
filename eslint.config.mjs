import { defineConfig } from "eslint/config";
import typescriptEslint from "@typescript-eslint/eslint-plugin";
import globals from "globals";
import tsParser from "@typescript-eslint/parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
    baseDirectory: __dirname,
    recommendedConfig: js.configs.recommended,
    allConfig: js.configs.all
});

export default defineConfig([
    // Build output — never lint generated code. `npm run lint` has no
    // `--ext .ts` effect under flat config (that flag is a legacy-config-only
    // option and is silently ignored here), so without this, `dist/**.js`
    // gets linted too whenever it exists on disk (e.g. after `npm run build`
    // runs before `npm run lint` in CI) — a byte-for-byte compiled mirror of
    // src/**/*.ts, reported at different line numbers, double-counting every
    // src violation. Found during civic-ai-tools#122 P4 lint calibration.
    {
        ignores: ["dist/**"],
    },
    // Ignore declaration files (d.ts files) completely
    {
        files: ["**/*.d.ts"],
        rules: {
            "@typescript-eslint/no-unused-vars": "off"
        }
    },
    {
    extends: compat.extends("eslint:recommended", "plugin:@typescript-eslint/recommended"),

    plugins: {
        "@typescript-eslint": typescriptEslint,
    },

    languageOptions: {
        globals: {
            ...globals.node,
        },

        parser: tsParser,
        ecmaVersion: 2022,
        sourceType: "module",
    },

    rules: {
        // --- civic-ai-tools#122 P4: lint calibration --------------------
        // Downgraded to "warn" as of civic-ai-tools#122 P4 because these
        // 6 rules account for all 122 pre-existing lint errors that predate
        // this repo's CI (counted with dist/** excluded from linting, per
        // the ignore above — generated output would otherwise double-count
        // every one of these): 86 @typescript-eslint/no-explicit-any,
        // 19 @typescript-eslint/no-unused-vars, 13 no-case-declarations,
        // 2 no-useless-escape, 1 prefer-const, 1
        // @typescript-eslint/no-require-imports. no-unused-vars spans 4
        // src files and 5 test files (not a single-file case), so a
        // per-rule downgrade is used rather than a file-scoped override.
        // Every other rule in this config is untouched and enforces at
        // "error" from CI's first run. The follow-up issue (tracked
        // alongside civic-ai-tools#122) re-promotes each of these 6 back
        // to "error" once the underlying violations are fixed — likely
        // cheapest during a future MCP/SDK modernization sprint, since the
        // no-explicit-any clusters sit in tool files that work would
        // rewrite anyway. Do not add new code that relies on these
        // warnings — this is a debt ceiling, not a license.
        "@typescript-eslint/no-explicit-any": "warn",
        "no-case-declarations": "warn",
        "no-useless-escape": "warn",
        "prefer-const": "warn",
        "@typescript-eslint/no-require-imports": "warn",
        // Disable unused vars check for .d.ts files
        "@typescript-eslint/no-unused-vars": ["warn", {
            "varsIgnorePattern": "^_",
            "argsIgnorePattern": "^_",
            "caughtErrorsIgnorePattern": "^_",
            "ignoreRestSiblings": true
        }]
    },
}]);