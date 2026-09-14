import {check} from './contracts.mjs';

export function validateEntityAttributes(content) {
  if (content.isExtra === undefined) return;
  check(content.type === 'CHARACTER', 'ENTITY_ATTRIBUTE_TYPE', '群演属性只属于具体人物 CHARACTER');
  check(content.isExtra === null || typeof content.isExtra === 'boolean', 'ENTITY_IS_EXTRA', '群演属性必须为 true、false 或 null（未知）');
}
export function entityAttributes(content) {
  return content.type === 'CHARACTER' ? {isExtra:typeof content.isExtra === 'boolean' ? content.isExtra : null} : {};
}

export const retiredEntityTypes=['ORGANIZATION','SOUND'];
export const retiredEntityType=id=>retiredEntityTypes.includes(typeof id==='string'?id.trim().toUpperCase():id);
export function currentDomainTypes(domain){return {...domain,entityTypes:domain.entityTypes.filter(type=>!retiredEntityType(type.id))};}

export function currentSystemEntityTypes(content) {
  return content.entityTypes?.entityTypes ? {...content,entityTypes:currentDomainTypes(content.entityTypes)} : {...content};
}
