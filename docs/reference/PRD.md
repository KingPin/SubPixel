Product Requirements Document (PRD): AgentPixelProject Name: AgentPixel (agentpixel / apx)Tagline: Universal Image Generation & Editing for AI Developer AgentsTarget Platforms: Claude Code CLI, Codex CLI, Cursor, Windsurf, Cline, Headless CI/CD1. Executive SummaryAgentPixel is a developer skill, MCP server, and lightweight CLI that enables terminal coding agents (particularly Claude Code) to prompt, generate, edit, and place raster image assets directly into project directories without context switching.Instead of requiring paid, per-call OpenAI Image API tokens, AgentPixel's primary engine runs non-interactively through the developer’s existing, authenticated local Codex CLI (codex exec), utilizing their ChatGPT Plus, Pro, or Team subscription quota. It also includes an automated fallback to standard OpenAI API keys (gpt-image-2 / dall-e-3) when headless or unauthenticated.2. Problem Statement & MotivationThe Terminal-to-Browser Gap: When autonomous agents build web apps, landing pages, mobile apps, or games, they frequently hit asset placeholders (<img src="/placeholder.png" />). Developers must stop the agent session, open a web browser (Midjourney, ChatGPT, Ideogram), prompt, download, rename, and relocate the asset manually.Double Billing Friction: Developers already paying $20–$200/month for ChatGPT subscriptions are disincentivized from buying separate metered API credits just to have their local CLI coding agents fetch occasional design assets.Agent Silos: Claude Code is an exceptional reasoning and implementation engine, but lacks native generative vision output. Codex CLI has native GPT Image capabilities, but developers often prefer Claude Code's developer ergonomics for large repository refactoring. AgentPixel bridges both.3. Goals and Non-Goals3.1 GoalsDual Execution Modes:Codex CLI Bridge Mode (Primary): Reuses the active ~/.codex/auth.json session via non-interactive execution (codex exec) using ChatGPT subscription credits.Direct API Mode (Fallback): Native OpenAI Image endpoint calls via OPENAI_API_KEY.Universal Agent Interfaces:MCP Server: Compatible with claude mcp add, Cursor, Windsurf, and Cline.Claude Code Skill (SKILL.md): Zero-overhead markdown skill loaded into ~/.claude/skills/agentpixel/SKILL.md.Standalone CLI: Callable directly from any terminal or subshell (agentpixel generate ...).Generation & Reference Editing:Text-to-Image: Prompt + style modifier + aspect ratio.Image-to-Image / Reference Conditioning: Modifying existing assets, combining styles, or retaining character/brand continuity using local reference paths (--image <path>).Deterministic Local Placement: Automatically detects project conventions (public/, assets/, src/assets/) and outputs Markdown / JSX image tags for immediate injection into code.3.2 Non-Goals (v1)Interactive GUI editing or canvas manipulation (cropping, brush masks, layer composition).Local GPU / Open-weight model hosting (e.g., Stable Diffusion, ComfyUI, Ollama)—AgentPixel strictly routes to GPT Image backends in v1.4. System Architecture & Mechanics                  ┌─────────────────────────────────────────────────────────┐
                  │                 Terminal Coding Agent                   │
                  │   Claude Code CLI  │  Cursor  │  Windsurf  │  Cline     │
                  └────────────┬─────────────────────────────┬──────────────┘
                               │                             │
                     MCP Tool Call (`call_tool`)    Bash Subprocess Execution
                               │                             │
                               ▼                             ▼
                  ┌─────────────────────────────────────────────────────────┐
                  │                 AgentPixel Core Engine                  │
                  │             (TypeScript / Node.js Runtime)              │
                  └────────────┬─────────────────────────────┬──────────────┘
                               │                             │
                         Backend Resolver               Workspace Auto-Detection
                               │                       (Reads package.json, dirs)
             ┌─────────────────┴──────────────────┐          │
             ▼                                    ▼          ▼
┌───────────────────────────────┐   ┌────────────────────────┐  ┌────────────────┐
│      Codex Bridge Engine      │   │    Direct API Engine   │  │ Asset Pipeline │
│                               │   │                        │  │                │
│ • Validates ~/.codex/auth.json│   │ • Reads OPENAI_API_KEY │  │ • Slug naming  │
│ • Runs isolated `codex exec`  │   │ • Calls gpt-image-2    │  │ • Optional     │
│   with ephemeral sandbox      │   │ • Handles rate limits  │  │   WebP optimize│
│ • Hooks $imagegen command     │   └───────────┬────────────┘  │ • MD/JSX tags  │
└──────────────┬────────────────┘               │               └────────┬───────┘
               │                                │                        │
               └────────────────┬───────────────┘                        │
                                ▼                                        ▼
                     Output Image (PNG/WebP) ────────────────► Project Workspace
                                                               `./public/images/`
4.1 The Codex Bridge Execution FlowAuth Detection: AgentPixel verifies that codex is present on $PATH and an active session exists in ~/.codex/auth.json (or $CODEX_HOME/auth.json).Workdir Staging:For generate jobs: Creates an isolated temporary directory.For edit jobs: Copies input references locally into ./references/ so Codex sandbox mounts can reliably access them.Headless Execution: Spawns:codex exec \
  --sandbox workspace-write \
  --skip-git-repo-check \
  --ephemeral \
  "$imagegen <structured_prompt>"
Output Extraction: Watches the sandbox output for generated image buffers, validates dimensions, and moves the final image to the designated workspace target path.5. Functional Requirements5.1 CLI Specifications (apx / agentpixel)# Basic Generation
agentpixel "A modern minimalist SaaS landing page hero graphic of an analytics dashboard, dark mode" -o ./public/hero.png

# Generation with aspect ratio and style
agentpixel generate \
  --prompt "Cyberpunk street market stall at night, neon reflections" \
  --aspect 16:9 \
  --quality high \
  --out ./src/assets/market.png

# Reference Editing / Style Transfer
agentpixel edit \
  --image ./assets/logo-sketch.png \
  --prompt "Convert this sketch into a sleek, 3D metallic vector icon on a dark background" \
  --out ./public/logo-rendered.png
Command Options:FlagShortDefaultDescription--output-o./assets/<slug>.pngTarget output path--backend-bautocodex, api, or auto (prefers codex if logged in)--aspect-asquaresquare (1024x1024), landscape (1536x1024), portrait (1024x1536)--image-inonePath to reference image for edit/style conditioning--format-fpngpng or webp--quality-qstandardstandard or high5.2 Model Context Protocol (MCP) InterfaceExposes tools for seamless autonomous calling by Claude Code:generate_imageInputs:prompt (string, required): Detailed visual description.targetPath (string, optional): Target file destination relative to project root.aspectRatio (enum: square | landscape | portrait): Format ratio.style (string, optional): Visual style modifier (e.g., "flat vector", "photorealistic", "pixel art").Returns:filePath: Absolute and relative workspace paths.markdown: Formatted image link (![alt](path)).jsx: Next.js / React Image component ready to paste.edit_imageInputs:referenceImage: Path to source image.instruction: Modifications to apply.targetPath: Destination file path.5.3 Claude Code Skill Definition (SKILL.md)Installed in ~/.claude/skills/agentpixel/SKILL.md to give Claude Code zero-setup guidance:---
name: agentpixel
description: Generate or edit images using Codex CLI subscription or OpenAI API
---

# AgentPixel Skill

When the user asks for images, icons, banners, UI mockups, or placeholders:
1. Formulate a descriptive, high-quality visual prompt based on the user's design context.
2. Call `agentpixel generate "<prompt>" -o <project_asset_path> --aspect <ratio>`.
3. Check the exit code. If successful, embed the resulting path into the relevant HTML/JSX/CSS code.
6. Project Layout & Tech StackRuntime: TypeScript / Node.js (fast startup, zero heavy dependencies, native across Mac/Linux/Windows).Package Management: npm / npx (runnable via npx agentpixel ... or global install).Dependencies:@modelcontextprotocol/sdk: MCP server foundation.commander: CLI argument parsing.execa: Robust cross-platform subprocess orchestration for codex exec.sharp (optional peer): Fast local WebP conversion and dimension validation.7. Success Criteria & MilestonesMilestoneTargetDescriptionM1: CLI SpawnerWeek 1Functional agentpixel CLI that runs codex exec in an isolated directory and saves clean PNGs.M2: Fallback APIWeek 1Auto-switch to OPENAI_API_KEY when codex is missing or unauthenticated.M3: Claude Code Skill & MCPWeek 2Standalone MCP server and SKILL.md tested end-to-end inside a live Claude Code session.M4: Image-to-Image / EditWeek 2Multi-image reference support with automatic WebP input compaction.
