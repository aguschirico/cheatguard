import tseslint from "typescript-eslint";

export default tseslint.config(...tseslint.configs.recommended, { rules: { "prefer-const": "error" } });
