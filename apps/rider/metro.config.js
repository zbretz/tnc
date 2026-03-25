const { getDefaultConfig } = require("expo/metro-config");
const { wrapWithReanimatedMetroConfig } = require("react-native-reanimated/metro-config");
const fs = require("fs");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

function resolveWorkletsPackageDir() {
  const candidates = [
    path.join(projectRoot, "node_modules/react-native-worklets"),
    path.join(workspaceRoot, "node_modules/react-native-worklets"),
  ];
  for (const dir of candidates) {
    try {
      const pkgPath = path.join(dir, "package.json");
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (pkg?.name === "react-native-worklets" && String(pkg.version || "").startsWith("0.5.")) {
        return dir;
      }
    } catch {
      /* try next */
    }
  }
  return path.join(projectRoot, "node_modules/react-native-worklets");
}

const workletsDir = resolveWorkletsPackageDir();
const workletsMainJs = path.join(workletsDir, "lib/module/index.js");

const config = getDefaultConfig(projectRoot);
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules ?? {}),
  "react-native-worklets": workletsDir,
};

const upstreamResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "react-native-worklets" && fs.existsSync(workletsMainJs)) {
    return { type: "sourceFile", filePath: workletsMainJs };
  }
  if (typeof upstreamResolveRequest === "function") {
    return upstreamResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = wrapWithReanimatedMetroConfig(config);
