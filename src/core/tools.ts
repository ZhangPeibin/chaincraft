import type { SessionState, ToolDefinition, ToolResult } from "./types.ts";

/** typed tool 注册表，是 Agent 和真实链上能力之间的执行边界。 */
export class ToolRegistry {
  /** 用 unknown 存储不同输入输出类型的工具，调用时由注册点和 call 泛型约束。 */
  private readonly tools = new Map<string, ToolDefinition<unknown, unknown>>();

  /** 注册一个工具；工具名重复说明能力边界冲突，直接失败。 */
  register<Input, Output>(tool: ToolDefinition<Input, Output>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }

    this.tools.set(tool.name, tool as ToolDefinition<unknown, unknown>);
  }

  /** 返回稳定排序后的工具列表，方便未来展示给模型或调试 UI。 */
  list(): ToolDefinition<unknown, unknown>[] {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 按名称调用工具；未知工具返回结构化错误而不是抛异常。 */
  async call<Output>(name: string, input: unknown, session: SessionState): Promise<ToolResult<Output>> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        ok: false,
        error: {
          code: "tool_failed",
          message: `Unknown tool: ${name}`,
        },
      };
    }

    return tool.execute(input, { session }) as Promise<ToolResult<Output>>;
  }
}
