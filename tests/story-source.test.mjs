import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import {describe, it} from "node:test";
import ts from "typescript";
import {parseStorySource} from "../src/story/parseStory.ts";
import {serializeStorySource} from "../src/story/serializeStory.ts";

const canonicalPath = resolve("stories/friday-deploy.yaml");

const validScene = `title: Test
scenes:
  - type: intro
    pose: formal
    background: office
    text: Test
    duration: 1
`;

describe("browser-safe Story source boundary", () => {
  it("parses the canonical YAML without filesystem coupling", async () => {
    const source = await readFile(canonicalPath, "utf8");
    const story = parseStorySource(source, "friday-deploy.yaml");

    assert.equal(story.title, "Deploy Friday");
    assert.equal(story.scenes.length, 4);
  });

  it("reports malformed YAML with source context", () => {
    assert.throws(
      () =>
        parseStorySource(
          `title: Broken
scenes:
  - type: intro
    pose: [formal
`,
          "broken.yaml",
        ),
      /Failed to parse YAML "broken\.yaml"/,
    );
  });

  it("reports schema paths and source context", () => {
    assert.throws(
      () =>
        parseStorySource(
          `title: Test
scenes:
  - type: montage
    pose: formal
    background: office
    text: Test
    duration: 1
`,
          "invalid.yaml",
        ),
      /Invalid story "invalid\.yaml":[\s\S]*scenes\.0\.type/,
    );
  });

  it("rejects invalid durations before rendering", () => {
    assert.throws(
      () =>
        parseStorySource(`title: Test
scenes:
  - type: intro
    pose: formal
    background: office
    text: Test
    duration: 0
`),
      /scenes\.0\.duration/,
    );
  });

  it("rejects caption text unsupported by the bundled font", () => {
    assert.throws(
      () =>
        parseStorySource(`title: Test
scenes:
  - type: intro
    pose: formal
    background: office
    text: "Tora 😀"
    duration: 1
`),
      /scenes\.0\.text/,
    );
  });

  it("round-trips a validated Story through canonical YAML", async () => {
    const source = await readFile(canonicalPath, "utf8");
    const story = parseStorySource(source, "friday-deploy.yaml");
    const serialized = serializeStorySource(story);
    const reparsed = parseStorySource(serialized, "round-trip.yaml");

    assert.deepEqual(reparsed, story);
  });

  it("serializes the same Story deterministically", () => {
    const story = parseStorySource(validScene);

    assert.equal(
      serializeStorySource(story),
      serializeStorySource(structuredClone(story)),
    );
  });

  it("keeps the browser-safe local dependency graph free of node:* imports", async () => {
    const compilerOptions = {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowImportingTsExtensions: true,
      jsx: ts.JsxEmit.ReactJSX,
    };

    const staticModuleSpecifiers = (path, source) => {
      const scriptKind = path.endsWith(".tsx")
        ? ts.ScriptKind.TSX
        : ts.ScriptKind.TS;
      const sourceFile = ts.createSourceFile(
        path,
        source,
        ts.ScriptTarget.Latest,
        true,
        scriptKind,
      );
      const specifiers = [];

      const visit = (node) => {
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteralLike(node.moduleSpecifier)
        ) {
          specifiers.push(node.moduleSpecifier.text);
        }

        if (
          ts.isImportEqualsDeclaration(node) &&
          ts.isExternalModuleReference(node.moduleReference) &&
          node.moduleReference.expression &&
          ts.isStringLiteralLike(node.moduleReference.expression)
        ) {
          specifiers.push(node.moduleReference.expression.text);
        }

        if (
          ts.isCallExpression(node) &&
          node.arguments.length === 1 &&
          ts.isStringLiteralLike(node.arguments[0]) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) &&
              node.expression.text === "require"))
        ) {
          specifiers.push(node.arguments[0].text);
        }

        ts.forEachChild(node, visit);
      };

      visit(sourceFile);
      return specifiers;
    };

    const pending = [
      resolve("src/story/parseStory.ts"),
      resolve("src/story/serializeStory.ts"),
    ];
    const visited = new Set();

    while (pending.length > 0) {
      const path = pending.pop();

      if (path === undefined || visited.has(path)) {
        continue;
      }

      visited.add(path);
      const source = await readFile(path, "utf8");

      for (const specifier of staticModuleSpecifiers(path, source)) {
        assert.equal(
          specifier.startsWith("node:"),
          false,
          `${path} must not import Node builtin ${specifier}`,
        );

        if (!specifier.startsWith(".")) {
          continue;
        }

        const resolvedModule = ts.resolveModuleName(
          specifier,
          path,
          compilerOptions,
          ts.sys,
        ).resolvedModule;

        assert.ok(
          resolvedModule,
          `Unable to resolve local dependency ${specifier} from ${path}`,
        );

        const dependencyPath = resolvedModule.resolvedFileName;

        if (
          dependencyPath.endsWith(".ts") ||
          dependencyPath.endsWith(".tsx")
        ) {
          pending.push(dependencyPath);
        }
      }
    }
  });

  it("keeps loadStory as a thin Node filesystem adapter", async () => {
    const source = await readFile(resolve("src/story/loadStory.ts"), "utf8");

    assert.match(source, /parseStorySource/);
    assert.doesNotMatch(source, /from\s+["']yaml["']/);
    assert.doesNotMatch(source, /StorySchema/);
  });
});
