export const retiredEntityType=id=>id==='ORGANIZATION';
export function currentDomainTypes(domain){return {...domain,entityTypes:domain.entityTypes.filter(type=>!retiredEntityType(type.id))};}
