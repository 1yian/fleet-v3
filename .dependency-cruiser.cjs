module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-unresolvable",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "core-never-imports-adapters",
      severity: "error",
      from: { path: "^src/(board|runner|axi)/" },
      to: { path: "^src/adapters/" },
    },
    {
      name: "src-not-to-dev-dependencies",
      severity: "error",
      from: { path: "^src/" },
      to: { dependencyTypes: ["npm-dev"], dependencyTypesNot: ["type-only"] },
    },
  ],
  options: {
    includeOnly: "^(src|e2e)/",
    exclude: { path: "(^|/)(node_modules|dist)/" },
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "default"] },
  },
};
