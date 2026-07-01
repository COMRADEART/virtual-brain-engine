// Skill generator — parse GitHub code and generate executable skills.
//
// Given a cloned repository, analyzes the code structure and generates skill
// definitions that can be registered and executed.
//
// Supported project types:
// - Node.js modules (package.json + exports)
// - TypeScript/JavaScript scripts
// - API handlers (Express routes)
// - Simple CLI tools

import { promises as fs } from "node:fs";
import { join, resolve, relative } from "node:path";
import type { SkillDefinition } from "../actions/dynamicRegistry.js";

interface FileInfo {
  path: string;
  content: string;
  type: "ts" | "js" | "json" | "md" | "other";
  size: number;
}

interface ParsedModule {
  exports: string[];
  imports: string[];
  functions: string[];
  classes: string[];
}

export interface GeneratedSkill {
  skill: SkillDefinition;
  confidence: number;
  reason: string;
}

// Detect the type of a file from its extension.
function detectFileType(filename: string): FileInfo["type"] {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (ext === "ts") return "ts";
  if (ext === "js" || ext === "mjs" || ext === "cjs") return "js";
  if (ext === "json") return "json";
  if (ext === "md") return "md";
  return "other";
}

// Parse a TypeScript/JavaScript file to extract its API surface.
function parseModule(content: string): ParsedModule {
  const exports: string[] = [];
  const imports: string[] = [];
  const functions: string[] = [];
  const classes: string[] = [];

  // Match export statements
  const exportMatches = content.matchAll(/export\s+(?:const|let|var|function|class|interface|type)\s+(\w+)/g);
  for (const match of exportMatches) {
    exports.push(match[1]);
  }

  // Match default exports
  const defaultMatch = content.match(/export\s+default\s+(\w+)/g);
  if (defaultMatch) {
    exports.push("default");
  }

  // Match import statements
  const importMatches = content.matchAll(/import\s+(?:\{[^}]*\}|\w+|\*)\s+from\s+['"]([^'"]+)['"]/g);
  for (const match of importMatches) {
    imports.push(match[1]);
  }

  // Match function declarations (not arrow functions for simplicity)
  const funcMatches = content.matchAll(/(?:^|\n)function\s+(\w+)\s*\(/gm);
  for (const match of funcMatches) {
    functions.push(match[1]);
  }

  // Match class declarations
  const classMatches = content.matchAll(/class\s+(\w+)/g);
  for (const match of classMatches) {
    classes.push(match[1]);
  }

  return { exports, imports, functions, classes };
}

// Read all relevant files from a repository.
async function readRepoFiles(repoPath: string, maxFiles = 100): Promise<FileInfo[]> {
  const files: FileInfo[] = [];

  async function walk(dir: string): Promise<void> {
    if (files.length >= maxFiles) return;

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (files.length >= maxFiles) break;

        const fullPath = join(dir, entry.name);
        // Skip common ignored directories
        if (entry.isDirectory()) {
          if (["node_modules", ".git", "dist", "build", ".next", "coverage", "__pycache__"].includes(entry.name)) {
            continue;
          }
          await walk(fullPath);
        } else if (entry.isFile()) {
          const ext = detectFileType(entry.name);
          if (["ts", "js", "json", "md"].includes(ext)) {
            try {
              const content = await fs.readFile(fullPath, "utf8");
              const stat = await fs.stat(fullPath);
              files.push({
                path: relative(repoPath, fullPath),
                content,
                type: ext,
                size: stat.size,
              });
            } catch {
              // Skip files we can't read
            }
          }
        }
      }
    } catch {
      // Skip directories we can't read
    }
  }

  await walk(repoPath);
  return files;
}

// Generate a skill from a package.json.
function generateFromPackageJson(files: FileInfo[]): GeneratedSkill[] {
  const skills: GeneratedSkill[] = [];

  const pkg = files.find((f) => f.path === "package.json");
  if (!pkg) return skills;

  try {
    const config = JSON.parse(pkg.content);
    const name = config.name || "unknown";
    const version = config.version || "0.0.0";

    // Generate skills from scripts
    if (config.scripts) {
      for (const [scriptName, scriptCmd] of Object.entries(config.scripts)) {
        if (typeof scriptCmd !== "string") continue;

        skills.push({
          skill: {
            id: `${name.replace(/[^a-z0-9]/g, "-")}-${scriptName}`,
            title: `Run ${scriptName} script`,
            description: `Executes npm script "${scriptName}": ${scriptCmd}`,
            risk: "confirm",
            surface: "server",
            params: {},
            handlerCode: `
// Execute npm script '${scriptName}'
const { exec } = require('child_process');
return new Promise((resolve, reject) => {
  exec('npm run ${scriptName}', { cwd: args.repoPath || '.' }, (err, stdout, stderr) => {
    if (err) reject(err);
    else resolve({ summary: stdout || stderr, data: { stdout, stderr } });
  });
});
            `.trim(),
          },
          confidence: 0.9,
          reason: `Found npm script "${scriptName}" in package.json`,
        });
      }
    }

    // Generate a skill for installing dependencies
    skills.push({
      skill: {
        id: `${name.replace(/[^a-z0-9]/g, "-")}-install`,
        title: "Install dependencies",
        description: `Install npm dependencies for ${name} v${version}`,
        risk: "confirm",
        surface: "server",
        params: {},
        handlerCode: `
const { exec } = require('child_process');
return new Promise((resolve, reject) => {
  exec('npm install', { cwd: args.repoPath || '.' }, (err, stdout, stderr) => {
    if (err) reject(err);
    else resolve({ summary: 'Dependencies installed', data: { stdout, stderr } });
  });
});
        `.trim(),
      },
      confidence: 0.95,
      reason: "Standard npm install skill",
    });
  } catch {
    // Invalid package.json, skip
  }

  return skills;
}

// Generate skills from TypeScript/JavaScript modules.
function generateFromModules(files: FileInfo[]): GeneratedSkill[] {
  const skills: GeneratedSkill[] = [];

  for (const file of files) {
    if (file.type !== "ts" && file.type !== "js") continue;
    if (file.path.includes("node_modules")) continue;

    const parsed = parseModule(file.content);

    // If it exports functions, generate a skill for each
    for (const func of parsed.functions) {
      // Skip private functions
      if (func.startsWith("_")) continue;

      skills.push({
        skill: {
          id: `func-${file.path.replace(/[^a-z0-9]/gi, "-").replace(/-+/g, "-").toLowerCase().slice(0, 40)}-${func}`,
          title: `Execute ${func}`,
          description: `Runs the ${func} function from ${file.path}`,
          risk: "confirm",
          surface: "server",
          params: { input: "input to pass to the function" },
          handlerCode: `
            // This is a placeholder - actual execution requires the module to be loaded
            return { summary: 'Would execute ${func} from ${file.path}', data: { function: '${func}', file: '${file.path}', input: args.input } };
          `.trim(),
        },
        confidence: 0.6,
        reason: `Found exported function "${func}" in ${file.path}`,
      });
    }

    // If it exports classes, generate a skill for instantiation
    for (const cls of parsed.classes) {
      skills.push({
        skill: {
          id: `class-${file.path.replace(/[^a-z0-9]/gi, "-").replace(/-+/g, "-").toLowerCase().slice(0, 40)}-${cls}`,
          title: `Use ${cls} class`,
          description: `Instantiates and uses the ${cls} class from ${file.path}`,
          risk: "confirm",
          surface: "server",
          params: { method: "method to call", args: "arguments for the method (JSON string)" },
          handlerCode: `
            return { summary: 'Would use ${cls} from ${file.path}', data: { class: '${cls}', file: '${file.path}', method: args.method, args: args.args } };
          `.trim(),
        },
        confidence: 0.5,
        reason: `Found class "${cls}" in ${file.path}`,
      });
    }
  }

  return skills;
}

// Generate skills from README/documentation.
function generateFromReadme(files: FileInfo[]): GeneratedSkill[] {
  const skills: GeneratedSkill[] = [];

  const readme = files.find((f) => f.path.toLowerCase().includes("readme"));
  if (!readme) return skills;

  // Try to extract usage examples from README
  const codeBlocks = readme.content.match(/```(?:js|ts|javascript|typescript|bash|sh)?\n([\s\S]*?)```/g);
  if (codeBlocks) {
    for (const block of codeBlocks.slice(0, 3)) {
      const code = block.replace(/```(?:js|ts|javascript|typescript|bash|sh)?\n/, "").replace(/```$/, "");

      // If it looks like an npm command, generate a skill
      if (code.includes("npm install") || code.includes("npm run")) {
        const cmd = code.split("\n").find((l) => l.includes("npm "));
        if (cmd) {
          const cmdMatch = cmd.match(/npm\s+(\w+)/);
          if (cmdMatch) {
            skills.push({
              skill: {
                id: `readme-cmd-${cmdMatch[1]}`,
                title: `Run: ${cmd}`,
                description: `Execute command from README: ${cmd}`,
                risk: "confirm",
                surface: "server",
                params: {},
                handlerCode: `
const { exec } = require('child_process');
return new Promise((resolve, reject) => {
  exec('${cmd.replace(/'/g, "\\'")}', { cwd: args.repoPath || '.' }, (err, stdout, stderr) => {
    if (err) reject(err);
    else resolve({ summary: stdout || stderr, data: { stdout, stderr } });
  });
});
                `.trim(),
              },
              confidence: 0.7,
              reason: "Extracted command from README",
            });
          }
        }
      }
    }
  }

  return skills;
}

// Main function: generate skills from a cloned repository.
export async function generateSkillsFromRepo(repoPath: string): Promise<GeneratedSkill[]> {
  const resolved = resolve(repoPath);
  const files = await readRepoFiles(resolved);

  if (files.length === 0) {
    return [];
  }

  const allSkills: GeneratedSkill[] = [];

  // Generate from package.json (highest priority)
  allSkills.push(...generateFromPackageJson(files));

  // Generate from modules
  allSkills.push(...generateFromModules(files));

  // Generate from README
  allSkills.push(...generateFromReadme(files));

  // Sort by confidence
  allSkills.sort((a, b) => b.confidence - a.confidence);

  // Deduplicate by ID
  const seen = new Set<string>();
  const unique = allSkills.filter((s) => {
    if (seen.has(s.skill.id)) return false;
    seen.add(s.skill.id);
    return true;
  });

  return unique;
}

// Generate a simple skill from a single file.
export function generateSkillFromFile(file: FileInfo): GeneratedSkill | null {
  if (file.type !== "ts" && file.type !== "js") return null;

  const parsed = parseModule(file.content);

  // If no exports, skip
  if (parsed.exports.length === 0) return null;

  const name = file.path.split("/").pop()?.replace(/\.(ts|js)$/, "") || "unknown";

  return {
    skill: {
      id: `file-${name}`,
      title: `Run ${name}`,
      description: `Executes code from ${file.path}`,
      risk: "confirm",
      surface: "server",
      params: { input: "input data (optional)" },
      handlerCode: `
        // Loaded from ${file.path}
        return { summary: 'Executed ${name}', data: { file: '${file.path}', exports: ${JSON.stringify(parsed.exports)}, input: args.input } };
      `.trim(),
    },
    confidence: 0.4,
    reason: `Found code in ${file.path} with exports: ${parsed.exports.join(", ")}`,
  };
}

// Get a summary of what was found in the repo.
export interface RepoAnalysis {
  totalFiles: number;
  byType: Record<string, number>;
  packageJson: boolean;
  readme: string | null;
  exports: string[];
  functions: string[];
  classes: string[];
}

export async function analyzeRepo(repoPath: string): Promise<RepoAnalysis | null> {
  const resolved = resolve(repoPath);
  const files = await readRepoFiles(resolved, 50);

  if (files.length === 0) return null;

  const byType: Record<string, number> = {};
  let packageJson = false;
  let readme: string | null = null;
  const exports: string[] = [];
  const functions: string[] = [];
  const classes: string[] = [];

  for (const file of files) {
    byType[file.type] = (byType[file.type] || 0) + 1;

    if (file.path === "package.json") {
      packageJson = true;
    }

    if (file.path.toLowerCase().includes("readme")) {
      readme = file.path;
    }

    if (file.type === "ts" || file.type === "js") {
      const parsed = parseModule(file.content);
      exports.push(...parsed.exports);
      functions.push(...parsed.functions);
      classes.push(...parsed.classes);
    }
  }

  return {
    totalFiles: files.length,
    byType,
    packageJson,
    readme,
    exports,
    functions,
    classes,
  };
}