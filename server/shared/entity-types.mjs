export const retiredEntityTypes=['ORGANIZATION','SOUND'];
export const retiredEntityType=id=>retiredEntityTypes.includes(typeof id==='string'?id.trim().toUpperCase():id);
export function currentDomainTypes(domain){return {...domain,entityTypes:domain.entityTypes.filter(type=>!retiredEntityType(type.id))};}

export function currentSystemEntityTypes(content) {
  return content.entityTypes?.entityTypes ? {...content,entityTypes:currentDomainTypes(content.entityTypes)} : {...content};
}
