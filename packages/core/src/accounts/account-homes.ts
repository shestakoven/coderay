import { join } from 'node:path';
import { ENGINE_IDS, type EngineId } from '@ide/protocol';

/** The engines CodeRay keeps accounts for: Claude's and Codex's sign-ins, opencode's profiles. */
export type AccountEngine = EngineId;

export const ACCOUNT_ENGINES: readonly AccountEngine[] = ENGINE_IDS;

/** How an engine runs under an account: its home, the variables that point it there, the credentials it must not see, and its flags. */
export interface AccountHome {
  readonly dir: string | null;
  readonly env: Readonly<Record<string, string>>;
  readonly unset: readonly string[];
  readonly args: readonly string[];
}

export type SignedHome = AccountHome & { dir: string };

export const ACCOUNT_DIRS: Record<AccountEngine, string> = { claude: 'claude-accounts', codex: 'codex-accounts', opencode: 'opencode-accounts' };

/** System: the engine's own home, with the core's environment and its credentials. Frozen: every chat under System shares it. */
export const SYSTEM_HOME: AccountHome = Object.freeze({
  dir: null, env: Object.freeze<Record<string, string>>({}), unset: Object.freeze<string[]>([]), args: Object.freeze<string[]>([]),
});

// Every provider's variables in opencode 1.19's catalog (GET /provider, Q3), then the cloud SDKs' own credentials (R16).
const OPENCODE_PROVIDER_VARS = `
  302AI_API_KEY ABACUS_API_KEY ABLIT_KEY ABOVE_API_KEY AGENTROUTER_API_KEY AGNES_API_KEY AI21_API_KEY AIAND_API_KEY AICORE_SERVICE_KEY AIHUBMIX_API_KEY
  AINETCAFE_API_KEY AIXY_API_KEY AI_GATEWAY_API_KEY AI_ROUTER_API_KEY AKI_IO_API_KEY ALIBABA_CODING_PLAN_API_KEY ALIBABA_TOKEN_PLAN_API_KEY
  AMBIENT_API_KEY AMD_API_KEY ANTHROPIC_API_KEY ANYAPI_API_KEY ARCEE_API_KEY ARK_API_KEY ARK_CODING_PLAN_API_KEY ATOMIC_CHAT_API_KEY AURIKO_API_KEY
  AWS_ACCESS_KEY_ID AWS_BEARER_TOKEN_BEDROCK AWS_REGION AWS_SECRET_ACCESS_KEY AZURE_API_KEY AZURE_COGNITIVE_SERVICES_API_KEY
  AZURE_COGNITIVE_SERVICES_RESOURCE_NAME AZURE_RESOURCE_NAME BAILING_API_TOKEN BASETEN_API_KEY BEE_API_KEY BERGET_API_KEY BLUECLAW_API_KEY
  BOTHUB_API_KEY CEREBRAS_API_KEY CHUTES_API_KEY CLARIFAI_PAT CLAUDINIO_API_KEY CLINE_API_KEY CLOUDFERRO_SHERLOCK_API_KEY CLOUDFLARE_ACCOUNT_ID
  CLOUDFLARE_API_KEY CLOUDFLARE_API_TOKEN CLOUDFLARE_GATEWAY_ID COHERE_API_KEY CORAL_API_KEY CORTECS_API_KEY CROF_API_KEY CROSSMODEL_API_KEY
  CRUSOE_API_KEY DAOXE_API_KEY DASHSCOPE_API_KEY DATABRICKS_HOST DATABRICKS_TOKEN DEEPINFRA_API_KEY DEEPSEEK_API_KEY DIGITALOCEAN_ACCESS_TOKEN
  DINFERENCE_API_KEY DRUN_API_KEY EBCLOUD_API_KEY ECHO_API_KEY EDENAI_API_KEY EMPIRIOLABS_API_KEY ENGY_API_KEY EVROC_API_KEY FASTROUTER_API_KEY
  FIREWORKS_API_KEY FREEMODEL_API_KEY FRIENDLI_TOKEN FROGBOT_API_KEY GEMINI_API_KEY GITHUB_TOKEN GITLAB_TOKEN GMICLOUD_API_KEY GOOGLE_API_KEY
  GOOGLE_APPLICATION_CREDENTIALS GOOGLE_GENERATIVE_AI_API_KEY GOOGLE_VERTEX_LOCATION GOOGLE_VERTEX_PROJECT GREENPT_API_KEY GROQ_API_KEY
  HELICONE_API_KEY HETZNER_API_KEY HF_TOKEN HPC_AI_API_KEY HYPER_API_KEY IFLOW_API_KEY IMPOSSIBL_API_KEY INCEPTION_API_KEY INCEPTRON_API_KEY
  INCO_API_KEY INFERENCE_API_KEY INFERX_API_KEY INFER_API_KEY INFOMANIAK_API_KEY INFOMANIAK_PRODUCT_ID IOINTELLIGENCE_API_KEY ITERACOMPUTE_API_KEY
  JALAPENO_API_KEY JIEKOU_API_KEY KENARI_API_KEY KILO_API_KEY KIMI_API_KEY KLOKINTEGRATION_API_KEY KOSMIK_API_KEY KUAE_API_KEY LILAC_API_KEY
  LLAMA_API_KEY LLMGATEWAY_API_KEY LLMTECH_API_KEY LLMTR_API_KEY LMSTUDIO_API_KEY LONGCAT_API_KEY LOWROUTER_API_KEY LUCIDQUERY_API_KEY LYNKR_API_KEY
  MEGANOVA_API_KEY MELIOUS_API_KEY MERGE_GATEWAY_API_KEY META_MODEL_API_KEY MINIMAX_API_KEY MISTRAL_API_KEY MIXLAYER_API_KEY MOARK_API_KEY
  MODAL_PROXY_TOKEN MODELIS_API_KEY MODELSCOPE_API_KEY MODEL_ORACLE_API_KEY MOONSHOT_API_KEY MORPH_API_KEY NANO_GPT_API_KEY NAN_API_KEY NEARAI_API_KEY
  NEBIUS_API_KEY NEON_AI_GATEWAY_BASE_URL NEON_AI_GATEWAY_TOKEN NEOSMITH_API_KEY NEURALWATT_API_KEY NOVA_API_KEY NOVITA_API_KEY NVIDIA_API_KEY
  OCI_GENAI_API_KEY OFOX_API_KEY OLLAMA_API_KEY OPENAI_API_KEY OPENCODE_API_KEY OPENREASON_API_KEY OPENROUTER_API_KEY OPPER_API_KEY ORCAROUTER_API_KEY
  OVHCLOUD_API_KEY PARETO_API_KEY PENDRA_API_KEY PERPLEXITY_API_KEY PIONEER_API_KEY POE_API_KEY POOLSIDE_API_KEY PRIVATEMODE_API_KEY
  PRIVATEMODE_ENDPOINT QIHANG_API_KEY QINIU_API_KEY QVAC_API_KEY REGOLO_API_KEY REQUESTY_API_KEY ROUTING_RUN_API_KEY RUNINFRA_GATEWAY_KEY
  SAKANA_API_KEY SALAD_CLOUD_API_KEY SARVAM_API_KEY SCALEWAY_API_KEY SCNET_API_KEY SCX_API_KEY SENSENOVA_API_KEY SILICONFLOW_API_KEY
  SILICONFLOW_CN_API_KEY SNOWFLAKE_ACCOUNT SNOWFLAKE_CORTEX_PAT STACKIT_API_KEY STANDARDCOMPUTE_API_KEY STEPFUN_API_KEY SUBCONSCIOUS_API_KEY
  SUBMODEL_INSTAGEN_ACCESS_KEY SYNTHETIC_API_KEY TEMPR_API_KEY TENCENT_CODING_PLAN_API_KEY TENCENT_TOKENHUB_API_KEY TENCENT_TOKEN_PLAN_API_KEY
  TENSORX_API_KEY THEGRID_API_KEY TINFOIL_API_KEY TINKER_API_KEY TOGETHER_API_KEY TOKENGO_API_KEY TOKENROUTER_API_KEY TRUSTEDROUTER_API_KEY
  UMANS_AI_API_KEY UMANS_AI_CODING_PLAN_API_KEY UNOROUTER_API_KEY UPSTAGE_API_KEY VANCINE_API_KEY VENICE_API_KEY VISPARK_LAB_API_KEY VIVGRID_API_KEY
  VULTR_API_KEY WAFER_API_KEY WALLABY_API_KEY WANDB_API_KEY WATSONX_AI_APIKEY WATSONX_AI_PROJECT_ID XAI_API_KEY XIAOMI_API_KEY XPERSONA_API_KEY
  ZELDOC_API_KEY ZENIFRA_AI_KEY ZENMUX_API_KEY ZHIPU_API_KEY
  AZURE_OPENAI_API_KEY AWS_SESSION_TOKEN AWS_PROFILE GH_TOKEN
`.trim().split(/\s+/);

// A credential in the core's environment would sign the engine in instead of the account, or connect a provider the profile did not.
export const CREDENTIAL_VARS: Record<AccountEngine, readonly string[]> = {
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'],
  codex: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
  opencode: OPENCODE_PROVIDER_VARS,
};

const XDG_HOMES = { XDG_DATA_HOME: 'data', XDG_CONFIG_HOME: 'config', XDG_STATE_HOME: 'state', XDG_CACHE_HOME: 'cache' } as const;

/** The directories under an opencode profile that `createDir` makes: its XDG homes. */
export const OPENCODE_HOME_DIRS: readonly string[] = Object.values(XDG_HOMES);

export function accountHome(engine: AccountEngine, dir: string): SignedHome {
  if (engine === 'claude') return { dir, env: { CLAUDE_CONFIG_DIR: dir }, unset: [...CREDENTIAL_VARS.claude], args: [] };
  if (engine === 'opencode') {
    // The cloud SDKs read their shared files from the user's home, not from XDG: a profile points them at its own, which do not exist.
    const env = {
      ...Object.fromEntries(Object.entries(XDG_HOMES).map(([name, sub]) => [name, join(dir, sub)])),
      AWS_SHARED_CREDENTIALS_FILE: join(dir, 'aws', 'credentials'), AWS_CONFIG_FILE: join(dir, 'aws', 'config'), CLOUDSDK_CONFIG: join(dir, 'gcloud'),
    };
    return { dir, env, unset: [...CREDENTIAL_VARS.opencode], args: [] };
  }
  // The file store keeps the credentials in the account's directory; the system keychain is one item for every home.
  return { dir, env: { CODEX_HOME: dir }, unset: [...CREDENTIAL_VARS.codex], args: ['-c', 'cli_auth_credentials_store="file"'] };
}

const shellQuoted = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** The terminal command that signs a profile's OAuth provider in: its four XDG homes, shell-quoted, then `opencode auth login`. */
export function opencodeLoginCommand(home: SignedHome): string {
  return [...Object.keys(XDG_HOMES).map((name) => `${name}=${shellQuoted(home.env[name] ?? '')}`), 'opencode auth login'].join(' ');
}
