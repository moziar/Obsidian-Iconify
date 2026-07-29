import { existsSync, readFileSync, writeFileSync } from "fs";

const targetVersion = process.env.npm_package_version;

let manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t"));

if (existsSync("versions.json")) {
	let versions = JSON.parse(readFileSync("versions.json", "utf8"));
	// Only update versions.json when minAppVersion changes
	const latestVersion = Object.keys(versions).sort().pop();
	if (!latestVersion || versions[latestVersion] !== minAppVersion) {
		versions[targetVersion] = minAppVersion;
		writeFileSync("versions.json", JSON.stringify(versions, null, "\t"));
	}
} else {
	let versions = {};
	versions[targetVersion] = minAppVersion;
	writeFileSync("versions.json", JSON.stringify(versions, null, "\t"));
}
