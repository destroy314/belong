import type { AppConfig } from './config.js';
import { loadConfig } from './config.js';
import { createDatabase, MetadataStore, type Family, type User } from './db.js';
import { InventoryStore } from './inventory.js';
import { validateLlmConfig } from './llm.js';
import { encryptSecret } from './security.js';

export const DEFAULT_DEVELOPMENT_INVENTORY = `# 家

## 客厅
### 电视柜
#### 左边抽屉
- 电视遥控器
- 空调遥控器
- 几节备用电池
- 各种设备的说明书

#### 下面一层
- 路由器
- 插线板
- 游戏机手柄

## 玄关柜
一共有三个抽屉

### 最上面的抽屉
- 口罩
- 钥匙
- 剪刀
- 胶带

### 最下面的抽屉
- 雨伞
- 鞋套
- 一个小工具箱

## 厨房
### 水槽下面的柜子
- 洗洁精
- 垃圾袋
- 清洁海绵

### 冰箱旁边的置物架
- 纸巾
- 保鲜膜
- 保鲜袋
- 常用调料

## 书房
### 书桌
#### 右侧第一个抽屉
- 充电线
- U盘
- 移动硬盘
- 备用鼠标

### 书架
#### 第二层
- 相机
- 两个镜头
- 相机充电器

#### 最下面一层
- 打印纸
- 文件夹

## 卧室
### 衣柜顶部
- 换季被子
- 旅行箱

### 床头柜抽屉
- 充电器
- 耳机
- 眼罩
- 常用药
`;

export interface DevelopmentFamilyInput {
  name: string;
  ownerOpenid: string;
  ownerNickname: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface CreatedDevelopmentFamily {
  family: Family;
  owner: User;
  inventory: string;
}

/** Create a local-only family with an encrypted BYOK setting and sample inventory. */
export async function createDevelopmentFamily(
  config: AppConfig,
  input: DevelopmentFamilyInput,
): Promise<CreatedDevelopmentFamily> {
  const llm = validateLlmConfig(input);
  if (!llm.apiKey) throw new Error('必须提供 API Key');

  const database = createDatabase(config.databasePath);
  try {
    const metadata = new MetadataStore(database);
    const owner = metadata.upsertUserByOpenId(input.ownerOpenid, {
      nickname: input.ownerNickname,
    });
    const family = metadata.createFamily(input.name, owner.id);
    metadata.upsertLlmConfig({
      familyId: family.id,
      baseUrl: llm.baseUrl,
      model: llm.model,
      apiKeyEncrypted: encryptSecret(
        llm.apiKey,
        config.encryptionKey,
        `family-llm:${family.id}`,
      ),
    });

    const inventory = new InventoryStore(config.inventoryDir);
    const initial = await inventory.load(family.id);
    const home = initial.view.lines.find((line) => line.text === '# 家');
    if (!home) throw new Error('无法初始化开发家庭库存');
    const seeded = await inventory.apply(family.id, initial.version, [
      {
        type: 'replace',
        startHash: home.hash,
        endHash: home.hash,
        text: DEFAULT_DEVELOPMENT_INVENTORY.trimEnd(),
      },
    ]);
    return { family, owner, inventory: seeded.content };
  } finally {
    database.close();
  }
}

export function developmentFamilyInputFromArgs(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): DevelopmentFamilyInput {
  const options = parseOptions(args);
  if (options.help) throw new Error(usage());

  return {
    name: optionOrEnvironment(options, 'name', environment.DEV_FAMILY_NAME, '本地演示家庭'),
    ownerOpenid: optionOrEnvironment(
      options,
      'openid',
      environment.DEV_FAMILY_OWNER_OPENID,
      'belong-dev-owner',
    ),
    ownerNickname: optionOrEnvironment(
      options,
      'nickname',
      environment.DEV_FAMILY_OWNER_NICKNAME,
      '开发者',
    ),
    baseUrl: optionOrEnvironment(options, 'base-url', environment.LLM_BASE_URL),
    model: optionOrEnvironment(options, 'model', environment.LLM_MODEL),
    apiKey: optionOrEnvironment(options, 'api-key', environment.LLM_API_KEY),
  };
}

type OptionName = 'name' | 'openid' | 'nickname' | 'base-url' | 'model' | 'api-key';
type ParsedOptions = Partial<Record<OptionName, string>> & { help?: boolean };

function parseOptions(args: readonly string[]): ParsedOptions {
  const supported = new Set<OptionName>([
    'name',
    'openid',
    'nickname',
    'base-url',
    'model',
    'api-key',
  ]);
  const options: ParsedOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (!argument.startsWith('--')) throw new Error(`未知参数：${argument}\n\n${usage()}`);
    const [rawName, inlineValue] = argument.slice(2).split('=', 2);
    if (!rawName || !supported.has(rawName as OptionName)) {
      throw new Error(`未知参数：${argument}\n\n${usage()}`);
    }
    const name = rawName as OptionName;
    const value = inlineValue ?? args[++index];
    if (!value || value.startsWith('--')) {
      throw new Error(`参数 --${name} 缺少值\n\n${usage()}`);
    }
    options[name] = value;
  }
  return options;
}

function optionOrEnvironment(
  options: ParsedOptions,
  option: OptionName,
  environmentValue: string | undefined,
  fallback?: string,
): string {
  const value = options[option] ?? environmentValue ?? fallback;
  if (!value?.trim()) {
    throw new Error(`缺少 --${option} 参数或对应环境变量\n\n${usage()}`);
  }
  return value.trim();
}

function usage(): string {
  return [
    '用法：npm run dev:create-family -- [选项]',
    '',
    '必填配置：--base-url、--model、--api-key（也可分别使用 LLM_BASE_URL、LLM_MODEL、LLM_API_KEY）',
    '可选：--name、--openid、--nickname',
  ].join('\n');
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('dev:create-family 仅可在开发环境执行');
  }
  if (process.argv.slice(2).some((argument) => argument === '--help' || argument === '-h')) {
    console.log(usage());
    return;
  }
  const created = await createDevelopmentFamily(
    loadConfig(),
    developmentFamilyInputFromArgs(process.argv.slice(2)),
  );
  console.log(`已创建开发家庭：${created.family.name}`);
  console.log(`家庭 ID：${created.family.id}`);
  console.log(`邀请码：${created.family.inviteCode}`);
  console.log(`库存已写入 ${created.inventory.split('\n').filter(Boolean).length} 行示例数据。`);
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : '创建开发家庭失败');
    process.exitCode = 1;
  });
}
