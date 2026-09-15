/**
 * A promise nobody holds. `doThing()` on its own line starts the work and
 * throws the result away, so a rejection becomes an unhandled rejection: in the
 * main process that is a silent failure, and in the renderer it is a step that
 * sits on "checking" for ever.
 *
 * The compiler has no rule for this at any strictness - `strict` does not cover
 * it and neither does `noUncheckedIndexedAccess`. The type-aware lint rule that
 * does cover it costs an eslint install, so this is the same shape as
 * `check-renderer-ids.mjs`: a small checker for a rule no dependency here
 * provides.
 *
 * The escape hatch is `void` at the call site, which is the documented way to
 * say "deliberately not awaited" and, unlike an allowlist in this file, is
 * visible to the person reading the code.
 *
 * Exits non-zero on a finding; run by the test suite and safe to run locally.
 */
import { createRequire } from "node:module";
import * as path from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");

/**
 * Source projects only. Test files are left out deliberately: a floating
 * promise in a test usually shows up as the test failing or going flaky, and
 * including them roughly doubles the work for the weaker signal.
 */
const DEFAULT_PROJECTS = [
  "packages/shared/tsconfig.json",
  "packages/relay/tsconfig.json",
  "packages/companion/tsconfig.json",
  "apps/hosted-relay/tsconfig.json",
  // main, preload and renderer/app.ts - the app's own tsconfig omits the renderer
  "apps/standalone/tsconfig.typecheck.json",
];

const projects = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_PROJECTS;

function parse(configPath) {
  const abs = path.resolve(configPath);
  const host = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, " "));
    },
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(abs, {}, host);
  if (!parsed) throw new Error(`could not read ${configPath}`);
  return {
    program: ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options }),
    // a project owns the files under its own config, not the files under
    // whatever directory this was invoked from
    home: path.dirname(abs),
  };
}

/** does this type have a callable `then`, i.e. is it awaitable */
function thenable(type, checker) {
  if (!type) return false;
  if (type.isUnion()) return type.types.some((t) => thenable(t, checker));
  const then = type.getProperty("then");
  if (!then) return false;
  const decl = then.valueDeclaration ?? then.declarations?.[0];
  if (!decl) return false;
  return checker.getTypeOfSymbolAtLocation(then, decl).getCallSignatures().length > 0;
}

/** a rejection this expression already deals with itself */
function handlesRejection(expr) {
  if (!ts.isCallExpression(expr)) return false;
  if (!ts.isPropertyAccessExpression(expr.expression)) return false;
  const method = expr.expression.name.text;
  if (method === "catch" || method === "finally") return true;
  // .then(onFulfilled, onRejected) - two arguments, so a rejection has a home
  return method === "then" && expr.arguments.length >= 2;
}

const findings = [];
let filesScanned = 0;
const seen = new Set();

for (const proj of projects) {
  const { program, home } = parse(proj);
  const checker = program.getTypeChecker();

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    // inside the project's own tree, not merely inside the working directory -
    // getting this wrong made every fixture scan zero files and pass
    const owned = path.relative(home, sf.fileName).split(path.sep).join("/");
    if (owned.startsWith("..") || owned.includes("node_modules") || owned.includes("dist/")) continue;
    const fromHere = path.relative(process.cwd(), sf.fileName).split(path.sep).join("/");
    const rel = fromHere.startsWith("..") ? owned : fromHere;
    if (seen.has(rel)) continue;
    seen.add(rel);
    filesScanned += 1;

    const visit = (node) => {
      if (ts.isExpressionStatement(node)) {
        const e = node.expression;
        const excused =
          ts.isAwaitExpression(e) ||
          // `void p` - the documented "deliberately not awaited"
          ts.isVoidExpression(e) ||
          // `p = somePromise` hands the promise to a variable that holds it;
          // the real rule excludes this and so must we, or the checker reports
          // a site nobody can fix
          ts.isBinaryExpression(e) ||
          handlesRejection(e);

        if (!excused && thenable(checker.getTypeAtLocation(e), checker)) {
          const { line } = sf.getLineAndCharacterOfPosition(e.getStart(sf));
          findings.push({
            where: `${rel}:${line + 1}`,
            text: e.getText(sf).split("\n")[0].trim().slice(0, 80),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
}

// A checker that examined nothing must not report success. check-renderer-ids
// shipped with exactly that hole - it printed "skip" and exited 0 when a page
// it was meant to read had gone missing.
if (filesScanned === 0) {
  console.error(`\nscanned no files at all across ${projects.length} project(s) - that is a broken check, not a pass`);
  process.exit(1);
}

if (findings.length) {
  console.error(`\n${findings.length} floating promise(s) - the result is discarded, so a rejection is unhandled`);
  for (const f of findings) console.error(`  - ${f.where}  ${f.text}`);
  console.error(`\nawait it, give it a .catch(), or write \`void\` to say the result is deliberately dropped`);
  process.exit(1);
}
console.log(`no floating promises in ${filesScanned} files across ${projects.length} project(s)`);
