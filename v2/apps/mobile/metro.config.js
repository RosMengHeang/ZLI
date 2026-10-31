const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const workspaceRoot = path.resolve(__dirname, "../..");
const nodeModules = `${path.sep}node_modules${path.sep}`;

// The app imports only workspace packages, so other apps stay unwatched. Their build output can be
// locked by antivirus, and Metro's crawl crashes on a file it cannot stat.
config.watchFolders = [path.join(workspaceRoot, "packages"), path.join(workspaceRoot, "node_modules")];

// Workspace sources, this app's included, are TypeScript that imports siblings as "./file.js", the
// NodeNext convention. Metro looks for that exact file, so retry those imports without the extension.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const origin = context.originModulePath;
  if (
    moduleName.startsWith(".") &&
    moduleName.endsWith(".js") &&
    origin.startsWith(workspaceRoot + path.sep) &&
    !origin.includes(nodeModules)
  ) {
    try {
      return context.resolveRequest(context, moduleName.slice(0, -3), platform);
    } catch {
      // Fall through to the request as written.
    }
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
