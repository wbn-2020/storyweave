import { DomainError, isRecord, optionalText, requiredInteger } from './api'

export const CHARACTER_PROFILE_SCHEMA_VERSION = 14
export const MAX_CHARACTER_PROFILE_FIELD_LENGTH = 4000
export const CHARACTER_PROFILE_FIELDS = ['motivation', 'desire', 'weakness', 'appearance', 'speechStyle', 'background', 'growthStages', 'skillLimits'] as const
export type CharacterProfileField = typeof CHARACTER_PROFILE_FIELDS[number]
export const CHARACTER_ABILITIES_SCHEMA_VERSION = 17
export const CHARACTER_ABILITIES = ['strength', 'agility', 'endurance', 'perception', 'reasoning', 'influence'] as const
export type CharacterAbility = typeof CHARACTER_ABILITIES[number]
export const CHARACTER_ABILITY_LABELS: Record<CharacterAbility, string> = {
  strength: '力量', agility: '敏捷', endurance: '耐力', perception: '感知', reasoning: '谋略', influence: '影响力',
}
export type CharacterProfile = Partial<Record<CharacterProfileField, string>> & { abilities?: Partial<Record<CharacterAbility, number>> }

export const CHARACTER_PROFILE_LABELS: Record<CharacterProfileField, string> = {
  motivation: '动机', desire: '愿望', weakness: '弱点', appearance: '外貌',
  speechStyle: '说话风格', background: '背景', growthStages: '成长阶段', skillLimits: '技能限制',
}

export function parseCharacterProfile(value: unknown): CharacterProfile {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'abilities' && !CHARACTER_PROFILE_FIELDS.includes(key as CharacterProfileField))) {
    throw new DomainError({ code: 'INVALID_INPUT', message: '人物档案格式无效或包含不支持的字段。' })
  }
  const profile: CharacterProfile = {}
  for (const key of CHARACTER_PROFILE_FIELDS) {
    if (value[key] === undefined) continue
    const text = optionalText(value[key], CHARACTER_PROFILE_LABELS[key], MAX_CHARACTER_PROFILE_FIELD_LENGTH)
    if (text.includes('\0')) throw new DomainError({ code: 'INVALID_INPUT', message: `${CHARACTER_PROFILE_LABELS[key]}不能包含空字符（NUL）。` })
    if (text) profile[key] = text
  }
  if (value.abilities !== undefined) {
    if (!isRecord(value.abilities) || Object.keys(value.abilities).some((key) => !CHARACTER_ABILITIES.includes(key as CharacterAbility))) {
      throw new DomainError({ code: 'INVALID_INPUT', message: '角色能力维度无效。' })
    }
    const abilities: NonNullable<CharacterProfile['abilities']> = {}
    for (const key of CHARACTER_ABILITIES) if (value.abilities[key] !== undefined) abilities[key] = requiredInteger(value.abilities[key], CHARACTER_ABILITY_LABELS[key], 100)
    if (Object.keys(abilities).length) profile.abilities = abilities
  }
  return profile
}
