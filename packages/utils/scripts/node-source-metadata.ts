import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ts } from "@ts-morph/common";
import type { BunPlugin, Loader } from "bun";

interface SourcePackage {
	name: string;
	sourceDir: string;
	metadataExported: boolean;
}

/** Preserve installed source-resource locations when Node chunks relocate module code. */
export async function createNodeSourceMetadataPlugin(packageDirs: readonly string[]): Promise<BunPlugin> {
	const packages: SourcePackage[] = [];
	for (const packageDir of packageDirs) {
		const manifest = JSON.parse(await fs.readFile(path.join(packageDir, "package.json"), "utf8")) as {
			name: string;
			exports?: Record<string, unknown>;
		};
		packages.push({
			name: manifest.name,
			sourceDir: path.join(packageDir, "src") + path.sep,
			metadataExported: manifest.exports?.["./package.json"] === "./package.json",
		});
	}
	return {
		name: "omp-node-source-metadata",
		target: "node",
		setup(build) {
			build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async args => {
				const owner = packages.find(pkg => args.path.startsWith(pkg.sourceDir));
				if (!owner) return undefined;
				const contents = await fs.readFile(args.path, "utf8");
				if (!contents.includes("import.meta.")) return undefined;
				const source = ts.createSourceFile(args.path, contents, ts.ScriptTarget.ESNext, true);
				const fileName = ts.factory.createUniqueName("__ompSourceFile");
				const directory = ts.factory.createUniqueName("__ompSourceDir");
				const fileUrlToPath = ts.factory.createUniqueName("__ompFileURLToPath");
				const dirname = ts.factory.createUniqueName("__ompDirname");
				let changed = false;
				let needsDirectory = false;
				const result = ts.transform(source, [
					context => root => {
						const visit: ts.Visitor = node => {
							if (
								ts.isPropertyAccessExpression(node) &&
								ts.isMetaProperty(node.expression) &&
								node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
								node.expression.name.text === "meta"
							) {
								if (node.name.text === "dirname" || node.name.text === "dir") {
									changed = needsDirectory = true;
									return directory;
								}
								if (node.name.text === "filename" || node.name.text === "path") {
									changed = true;
									return fileName;
								}
							}
							return ts.visitEachChild(node, visit, context);
						};
						return ts.visitNode(root, visit, ts.isSourceFile) ?? root;
					},
				]);
				try {
					if (!changed) return undefined;
					if (!owner.metadataExported)
						throw new Error(`${owner.name} must export ./package.json for Node SDK source resources`);
					const factory = ts.factory;
					const resource = "src/" + path.relative(owner.sourceDir, args.path).split(path.sep).join("/");
					const metadataUrl = factory.createCallExpression(
						factory.createPropertyAccessExpression(
							factory.createMetaProperty(ts.SyntaxKind.ImportKeyword, factory.createIdentifier("meta")),
							"resolve",
						),
						undefined,
						[factory.createStringLiteral(`${owner.name}/package.json`)],
					);
					const sourceFileUrl = factory.createNewExpression(factory.createIdentifier("URL"), undefined, [
						factory.createStringLiteral(resource),
						metadataUrl,
					]);
					const header: ts.Statement[] = [
						factory.createImportDeclaration(
							undefined,
							factory.createImportClause(
								false,
								undefined,
								factory.createNamedImports([
									factory.createImportSpecifier(
										false,
										factory.createIdentifier("fileURLToPath"),
										fileUrlToPath,
									),
								]),
							),
							factory.createStringLiteral("node:url"),
						),
						factory.createVariableStatement(
							undefined,
							factory.createVariableDeclarationList(
								[
									factory.createVariableDeclaration(
										fileName,
										undefined,
										undefined,
										factory.createCallExpression(fileUrlToPath, undefined, [sourceFileUrl]),
									),
								],
								ts.NodeFlags.Const,
							),
						),
					];
					if (needsDirectory) {
						header.unshift(
							factory.createImportDeclaration(
								undefined,
								factory.createImportClause(
									false,
									undefined,
									factory.createNamedImports([
										factory.createImportSpecifier(false, factory.createIdentifier("dirname"), dirname),
									]),
								),
								factory.createStringLiteral("node:path"),
							),
						);
						header.push(
							factory.createVariableStatement(
								undefined,
								factory.createVariableDeclarationList(
									[
										factory.createVariableDeclaration(
											directory,
											undefined,
											undefined,
											factory.createCallExpression(dirname, undefined, [fileName]),
										),
									],
									ts.NodeFlags.Const,
								),
							),
						);
					}
					const transformed = factory.updateSourceFile(result.transformed[0], [
						...header,
						...result.transformed[0].statements,
					]);
					const loader: Loader = args.path.endsWith(".tsx")
						? "tsx"
						: args.path.endsWith(".jsx")
							? "jsx"
							: /\.[cm]?js$/.test(args.path)
								? "js"
								: "ts";
					return { contents: ts.createPrinter().printFile(transformed), loader };
				} finally {
					result.dispose();
				}
			});
		},
	};
}
