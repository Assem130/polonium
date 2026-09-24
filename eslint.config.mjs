import { defineConfig, globalIgnores } from "eslint/config";
import tsParser from "@typescript-eslint/parser";

export default defineConfig([
    globalIgnores(["src/qml/focus-state.js", "pkg/**"]),
    {
        files: ["src/**/*.ts"],
        languageOptions: {
            globals: {},
            parser: tsParser,
            ecmaVersion: 5,
            sourceType: "module",

            parserOptions: {
                project: "./tsconfig.json",
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },
]);
