import type { SkillDefinition } from './types.js';

export class SkillExecutor {
  private skills: Map<string, SkillDefinition> = new Map();

  register(skill: SkillDefinition): void {
    this.skills.set(skill.name, skill);
  }

  registerAll(skills: SkillDefinition[]): void {
    for (const skill of skills) {
      this.register(skill);
    }
  }

  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  list(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }

  // 根据用户输入匹配 skill
  match(input: string): SkillDefinition | undefined {
    // 精确匹配 /command 格式
    const cmdMatch = input.match(/^\/(\S+)/);
    if (cmdMatch) {
      const name = cmdMatch[1];
      return this.skills.get(name);
    }

    // 关键词匹配
    for (const skill of this.skills.values()) {
      if (skill.activationKeywords?.some((kw) => input.toLowerCase().includes(kw.toLowerCase()))) {
        return skill;
      }
    }

    return undefined;
  }

  // 执行 skill，返回扩展后的 prompt
  expand(skill: SkillDefinition, args?: string): string {
    let prompt = skill.prompt;
    if (args) {
      prompt = prompt.replace('{{args}}', args).replace('{args}', args);
      // 如果 prompt 中没有占位符，追加到末尾
      if (!skill.prompt.includes('{{args}}') && !skill.prompt.includes('{args}')) {
        prompt += '\n\n' + args;
      }
    }
    return prompt;
  }
}
