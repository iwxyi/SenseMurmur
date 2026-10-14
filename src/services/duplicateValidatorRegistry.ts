import type { SessionDuplicateValidationContext, SessionDuplicateValidator, SessionValidationDecision } from '../types/sessionEngine';
import { evaluateDuplicateGuard } from './duplicateGuard';

const validators = new Map<string, SessionDuplicateValidator>();

const defaultValidator: SessionDuplicateValidator = {
  key: 'default',
  validate(context: SessionDuplicateValidationContext): SessionValidationDecision {
    const result = evaluateDuplicateGuard({
      content: context.content,
      messages: context.recentMessages,
      speakerId: context.speakerId,
      intentionalRepeat: false,
    });
    return {
      allowed: !result.blocked,
      reason: result.reason,
    };
  },
};

const companionValidator: SessionDuplicateValidator = {
  key: 'companion_room',
  validate(context: SessionDuplicateValidationContext): SessionValidationDecision {
    const result = evaluateDuplicateGuard({
      content: context.content,
      messages: context.recentMessages.slice(-2),
      speakerId: context.speakerId,
      intentionalRepeat: false,
    });
    return {
      allowed: !result.blocked,
      reason: result.reason,
    };
  },
};

function parseValidationSeed(content: string) {
  const [moveClass, targetScope, ...targetIds] = content.trim().split(':');
  if (!moveClass || !targetScope) return null;
  return {
    moveClass,
    targetScope,
    targetIds,
  };
}

const analyticalValidator: SessionDuplicateValidator = {
  key: 'analytical_room',
  validate(context: SessionDuplicateValidationContext): SessionValidationDecision {
    const trimmedContent = context.content.trim();
    const recentOwn = context.recentMessages
      .filter((message) => message.type === 'ai' && !message.isDeleted && message.senderId === context.speakerId)
      .slice(-3)
      .map((message) => message.content.trim());
    if (recentOwn.includes(trimmedContent)) {
      return {
        allowed: false,
        reason: "The draft exactly repeats the speaker's recent line.",
      };
    }
    const currentSeed = parseValidationSeed(trimmedContent);
    if (currentSeed) {
      const progressedOwnMove = recentOwn
        .map(parseValidationSeed)
        .find((seed) => seed
          && seed.targetScope === currentSeed.targetScope
          && seed.targetIds.join(':') === currentSeed.targetIds.join(':')
          && seed.moveClass !== currentSeed.moveClass);
      if (progressedOwnMove) {
        return {
          allowed: true,
          reason: null,
        };
      }
    }
    const result = evaluateDuplicateGuard({
      content: context.content,
      messages: context.recentMessages,
      speakerId: context.speakerId,
      intentionalRepeat: false,
    });
    return {
      allowed: !result.blocked,
      reason: result.reason,
    };
  },
};

validators.set(companionValidator.key, companionValidator);
validators.set(analyticalValidator.key, analyticalValidator);
validators.set(defaultValidator.key, defaultValidator);

export function registerDuplicateValidator(validator: SessionDuplicateValidator) {
  validators.set(validator.key, validator);
}

export function resolveDuplicateValidator(key?: string | null) {
  return (key && validators.get(key)) || defaultValidator;
}
