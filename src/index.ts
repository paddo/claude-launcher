#!/usr/bin/env bun
import { getConfig, saveConfig, type Backend } from "./config";
import { formatContext, type CatalogModel } from "./models";
import { pickBackend, pickMixedBackend, pickSlotEffort, pickCatalogModel, BACK } from "./picker";
import { login } from "./auth";
import { startMixedProxy, type MixedHandler } from "./mixed-proxy";
import { BACKEND_DEFS, defById, runBackend, resolveContext, ensureHost, loadModels, launchClaude, contextOverrideEnv } from "./backends";

const args = process.argv.slice(2);

function parseArgs() {
  const flags = {
    pick: undefined as Backend | undefined,
    backend: false,
    help: false,
    login: false,
    logout: false,
  };
  const passthrough: string[] = [];
  let seenDash = false;

  for (const arg of args) {
    if (seenDash) {
      passthrough.push(arg);
      continue;
    }
    const def = BACKEND_DEFS.find((d) => arg === d.longFlag || (d.shortFlag && arg === d.shortFlag));
    if (arg === "--") {
      seenDash = true;
    } else if (def) {
      flags.pick = def.id;
    } else if (arg === "--anthropic" || arg === "-a") {
      flags.pick = "anthropic";
    } else if (arg === "--mixed" || arg === "-x") {
      flags.pick = "mixed";
    } else if (arg === "--backend" || arg === "-b" || arg === "--model" || arg === "-m") {
      flags.backend = true;
    } else if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else if (arg === "login") {
      flags.login = true;
    } else if (arg === "logout") {
      flags.logout = true;
    } else {
      passthrough.push(arg);
    }
  }

  return { flags, passthrough };
}

function showHelp() {
  // Registry order, with the launcher-mode flags (-a, -x) interleaved to
  // match the backend picker.
  const defLines = BACKEND_DEFS.map((d) => `  ${d.shortFlag ? `${d.shortFlag}, ` : "    "}${d.longFlag}`.padEnd(20) + d.helpText);
  const options = [
    "  -b, --backend     Pick backend and model interactively",
    "  -m, --model       Alias for -b",
    defLines[0],
    "  -a, --anthropic   Use Anthropic backend",
    defLines[1],
    "  -x, --mixed       Use Mixed backend (Anthropic native + any backend per role slot)",
    ...defLines.slice(2),
    "  -h, --help        Show this help",
  ].join("\n");

  console.log(`claude-launcher - Launch Claude Code with multiple backends

Usage: claude-launcher [command] [options] [-- claude-args...]

Commands:
  login             Authenticate with OpenRouter
  logout            Clear stored OpenRouter API key

Options:
${options}

Examples:
  claude-launcher login              # authenticate with OpenRouter
  claude-launcher                    # uses last backend/model
  claude-launcher -b                 # pick backend and model
  claude-launcher -l                 # use Ollama local backend
  claude-launcher -n                 # use NVIDIA NIM backend
  claude-launcher -s                 # use LM Studio local backend
  claude-launcher -- --resume        # pass args to claude`);
}

async function main() {
  const { flags, passthrough } = parseArgs();

  if (flags.help) {
    showHelp();
    process.exit(0);
  }

  const config = getConfig();

  // Handle login command
  if (flags.login) {
    const apiKey = await login();
    config.openrouterApiKey = apiKey;
    config.backend = "openrouter";
    saveConfig(config);
    console.log("Logged in successfully!");
    process.exit(0);
  }

  // Handle logout command
  if (flags.logout) {
    delete config.openrouterApiKey;
    saveConfig(config);
    console.log("Logged out.");
    process.exit(0);
  }

  // Determine backend
  let backend: Backend;
  if (flags.backend) {
    backend = await pickBackend(BACKEND_DEFS, config.backend);
    config.backend = backend;
    saveConfig(config);
  } else if (flags.pick) {
    backend = flags.pick;
  } else if (config.backend) {
    backend = config.backend;
  } else {
    backend = await pickBackend(BACKEND_DEFS);
    config.backend = backend;
    saveConfig(config);
  }

  const def = defById(backend);
  if (def) {
    if ((await runBackend(def, config, flags.backend, passthrough)) === "back") return main();
  } else if (backend === "mixed") {
    const slots = () => [config.mixedModel, config.mixedOpusModel, config.mixedSonnetModel, config.mixedHaikuModel];
    const prefixOf = (s: string) => s.slice(0, s.indexOf(":"));
    const validSlot = (s: string) => s.indexOf(":") > 0 && BACKEND_DEFS.some((d) => d.id === prefixOf(s));

    // Catalogs and auth are fetched lazily so setup only touches the backends
    // actually routed to.
    const catalogs = new Map<Backend, CatalogModel[]>();
    const modelsFor = async (id: Backend): Promise<CatalogModel[]> => {
      let models = catalogs.get(id);
      if (!models) {
        ({ models } = await loadModels(defById(id)!, config));
        catalogs.set(id, models);
      }
      return models;
    };

    const pickSlot = async (label: string, current?: string, allowBack?: boolean): Promise<string | undefined | typeof BACK> => {
      const curBackend = current && validSlot(current) ? (prefixOf(current) as Backend) : undefined;
      const b = await pickMixedBackend(BACKEND_DEFS, label, curBackend, allowBack);
      if (b === BACK) return BACK;
      if (b === "claude") return undefined;
      const slotDef = defById(b)!;
      const curModel = current && curBackend === b ? current.slice(b.length + 1).replace(/@[^@]*$/, "") : undefined;
      await ensureHost(slotDef, config, false);
      const models = await modelsFor(b);
      const model = await pickCatalogModel(models, { current: curModel, label, search: slotDef.searchPicker });
      // An effort pick is encoded into the slot as "model@effort" so the pin
      // is visible wherever the model name shows (launch line, /model).
      const picked = models.find((m) => m.id === model)!;
      const efforts = slotDef.mixed.slotEfforts?.(picked) ?? picked.efforts ?? [];
      const effort = efforts.length ? await pickSlotEffort(efforts) : undefined;
      return `${b}:${effort ? `${model}@${effort}` : model}`;
    };

    // config.backend only becomes "mixed" after a completed setup, so an
    // all-Claude slot choice persists instead of re-prompting every launch.
    if (flags.backend || (config.backend !== "mixed" && !slots().some(Boolean)) || slots().some((s) => s && !validSlot(s))) {
      console.log("Each role stays on your Anthropic subscription unless routed to another backend.");
      try {
        const first = await pickSlot("Main model", config.mixedModel, flags.backend);
        if (first === BACK) return main();
        config.mixedModel = first;
        config.mixedOpusModel = (await pickSlot("Opus (complex tasks)", config.mixedOpusModel)) as string | undefined;
        config.mixedSonnetModel = (await pickSlot("Sonnet (lighter tasks)", config.mixedSonnetModel)) as string | undefined;
        config.mixedHaikuModel = (await pickSlot("Haiku (quick/cheap)", config.mixedHaikuModel)) as string | undefined;
      } catch (err) {
        if (err instanceof Error && err.name === "ExitPromptError") throw err;
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      config.backend = "mixed";
      saveConfig(config);
    }

    // Every backend with usable credentials is registered, not just the
    // configured slots, so /model backend:model mid-session can reach any of
    // them. Handlers resolve auth per request, so a backend the user never
    // routes to costs nothing.
    const routes: Record<string, MixedHandler> = {};
    for (const d of BACKEND_DEFS) {
      const handler = d.mixed.route(config);
      if (handler) routes[d.id] = handler;
    }

    // The context override follows the main slot's model: the interactive
    // session lives there, and Claude Code has only one global cap. Trade-off:
    // /model to a smaller-window model mid-session keeps the raised cap.
    let mainContext = 0;
    const mainSlot = config.mixedModel;
    if (mainSlot && validSlot(mainSlot)) {
      const mb = prefixOf(mainSlot) as Backend;
      const mm = mainSlot.slice(mb.length + 1).replace(/@[^@]*$/, "");
      try {
        const mixedDef = defById(mb)!;
        mainContext = await resolveContext(mixedDef, mm, config, () => modelsFor(mb));
      } catch (err) {
        // Ctrl-C inside a lazily-loaded catalog's prompts must still abort.
        if (err instanceof Error && err.name === "ExitPromptError") throw err;
        mainContext = 0;
      }
    }
    // Lazy catalog loads may have updated config (seenModels, adopted keys).
    saveConfig(config);

    console.log("Starting mixed proxy...");
    const proxy = await startMixedProxy(routes);

    // ANTHROPIC_AUTH_TOKEN/API_KEY must not reach Claude Code: their presence
    // (even inherited from the user's shell) switches it out of subscription
    // OAuth mode (claude-code#33330). Role env vars are set for any routed
    // slot; unrouted roles keep Claude Code's own defaults.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxy.port}`,
      ...contextOverrideEnv(mainContext),
    };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    if (config.mixedModel) env.ANTHROPIC_MODEL = config.mixedModel;
    if (config.mixedOpusModel) env.ANTHROPIC_DEFAULT_OPUS_MODEL = config.mixedOpusModel;
    if (config.mixedSonnetModel) env.ANTHROPIC_DEFAULT_SONNET_MODEL = config.mixedSonnetModel;
    if (config.mixedHaikuModel) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = config.mixedHaikuModel;

    console.log(
      `\nLaunching claude (mixed): main=${config.mixedModel ?? "claude"}${mainContext > 200000 ? ` [${formatContext(mainContext)}]` : ""} opus=${config.mixedOpusModel ?? "claude"} sonnet=${config.mixedSonnetModel ?? "claude"} haiku=${config.mixedHaikuModel ?? "claude"} (proxy :${proxy.port})...\n`
    );
    launchClaude(passthrough, env, () => proxy.close());
  } else {
    // Anthropic - just launch claude
    console.log("Launching claude...\n");
    launchClaude(passthrough);
  }
}

main().catch((err) => {
  if (err.name === "ExitPromptError") {
    process.exit(130);
  }
  console.error(err);
  process.exit(1);
});
