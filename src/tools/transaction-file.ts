import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ChainTransaction, ToolDefinition } from "../core/types.ts";

/** 读取本地归一化交易文件的输入。 */
export interface ReadNormalizedTransactionFileInput {
  /** JSON 文件路径；相对路径按当前工作目录解析。 */
  txPath: string;
}

/** 从本地 JSON fixture 读取归一化交易；ask 路径也必须通过 typed tool 获取这类事实。 */
export const readNormalizedTransactionFileTool: ToolDefinition<
  ReadNormalizedTransactionFileInput,
  ChainTransaction
> = {
  name: "read_normalized_transaction_file",
  description: "Read a normalized Chaincraft transaction JSON file from disk.",
  async execute(input) {
    if (!input.txPath.trim()) {
      return {
        ok: false,
        error: {
          code: "invalid_input",
          message: "Missing txPath for read_normalized_transaction_file.",
        },
      };
    }

    const resolved = path.resolve(process.cwd(), input.txPath);
    const raw = await readFile(resolved, "utf8");
    const parsed = JSON.parse(raw) as ChainTransaction & { blockNumber?: string | number };

    return {
      ok: true,
      value: {
        ...parsed,
        blockNumber: parsed.blockNumber === undefined ? undefined : BigInt(parsed.blockNumber),
        tokenTransfers: parsed.tokenTransfers ?? [],
      },
    };
  },
};
