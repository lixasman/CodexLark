import { normalizeWaitKind, type CommunicateWaitKind } from '../../protocol/wait-kinds';

export function detectWaitState(text: string): { waitKind: CommunicateWaitKind; waitOptions?: string[] } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const numberedOptions = Array.from(trimmed.matchAll(/^\s*\d+\.\s+(.+)$/gm)).map((match) => match[1]?.trim() ?? '');
  const choicePrompt =
    /select an option|choose an option|请选择|which would you prefer|which do you prefer|你更倾向于|你更喜欢|回复?(?:一个)?(?:选项号|序号)|回(?:一个)?(?:选项号|序号)|选项号就行|你希望按哪种|按哪种标准|选哪一个|选哪个/i;
  if (numberedOptions.length > 0 && choicePrompt.test(trimmed)) {
    return { waitKind: 'choice', waitOptions: numberedOptions };
  }

  if (/allow|confirm|是否继续|是否允许/i.test(trimmed)) {
    const waitKind = normalizeWaitKind('confirm');
    return waitKind ? { waitKind } : null;
  }

  if (/input[:：]|请输入|type your response/i.test(trimmed)) {
    const waitKind = normalizeWaitKind('text_input');
    return waitKind ? { waitKind } : null;
  }

  return null;
}

