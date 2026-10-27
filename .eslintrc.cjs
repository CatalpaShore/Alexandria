module.exports = {
  root: true,
  env: {
    browser: true,
    es2022: true,
    node: true
  },
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaFeatures: {
      jsx: true
    },
    ecmaVersion: "latest",
    sourceType: "module"
  },
  plugins: ["@typescript-eslint", "react-hooks"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  ignorePatterns: [
    "dist/",
    ".local/",
    "node_modules/",
    ".pnpm-store/",
    "data/",
    "seed/",
    "artifacts/",
    "android/.gradle/",
    "android/app/build/",
    "client/src/web-library/",
    "client/src/components/ProductSwitch.tsx",
    "server/src/webLibrary/",
    "server/src/webLibraryGateway.ts",
    "scripts/*web-library*",
    "tests/unit/web-library*.test.ts"
  ],
  rules: {
    "@typescript-eslint/no-unused-vars": [
      "error",
      {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_"
      }
    ],
    "react-hooks/rules-of-hooks": "error",
    "react-hooks/exhaustive-deps": ["warn", { additionalHooks: "useLocalizedMemo" }]
  }
};
