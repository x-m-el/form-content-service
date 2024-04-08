import {
  query,
  sparqlEscapeString,
  sparqlEscapeUri,
  sparqlEscapeDateTime,
} from 'mu';
import { InstanceData, InstanceMinimal } from '../../types';
import {
  buildFormConstructQuery,
  buildFormDeleteQuery,
} from '../../form-validator';
import {
  computeInstanceDeltaQuery,
  sparqlEscapeObject,
  ttlToInsert,
  ttlToTriplesAndPrefixes,
} from '../../helpers/ttl-helpers';
import { v4 as uuid } from 'uuid';
import comunicaRepo from './comunica-repository';
import { querySudo, updateSudo } from '@lblod/mu-auth-sudo';

const fetchFormTtlById = async (formId: string): Promise<string | null> => {
  const result = await query(`
    PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>
    PREFIX sh: <http://www.w3.org/ns/shacl#>
    PREFIX mu: <http://mu.semte.ch/vocabularies/core/>

    SELECT ?formDefinition ?formTtl
    WHERE {
      ?formDefinition a ext:GeneratedForm ;
        mu:uuid ${sparqlEscapeString(formId)} ;
        ext:ttlCode ?formTtl .
    } LIMIT 1
  `);

  if (result.results.bindings.length) {
    const binding = result.results.bindings[0];
    return binding.formTtl.value;
  } else {
    return null;
  }
};

const fetchFormTtlByUri = async (formUri: string): Promise<string | null> => {
  const result = await query(`
    PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>

    SELECT ?formTtl
    WHERE {
      ${sparqlEscapeUri(formUri)} a ext:GeneratedForm;
        ext:ttlCode ?formTtl.
    } LIMIT 1
  `);

  if (result.results.bindings.length) {
    const binding = result.results.bindings[0];
    return binding.formTtl.value;
  } else {
    return null;
  }
};

const buildConstructConceptSchemesQuery = (
  conceptSchemeUris: string[],
): string => {
  const uris = conceptSchemeUris.map(sparqlEscapeUri).join(' ');

  return `
    PREFIX skos: <http://www.w3.org/2004/02/skos/core#>

    CONSTRUCT {
      ?s ?p ?o
    } WHERE {
      ?s skos:inScheme ?scheme.
      VALUES ?scheme { ${uris} }
      ?s ?p ?o.
    }
    `;
};

const bindingToTriple = (binding) =>
  `${sparqlEscapeUri(binding.s.value)} ${sparqlEscapeUri(
    binding.p.value,
  )} ${sparqlEscapeObject(binding.o)} .`;

const getConceptSchemeTriples = async (conceptSchemeUris: string[]) => {
  const constructQuery = buildConstructConceptSchemesQuery(conceptSchemeUris);
  const result = await query(constructQuery);
  return result.results.bindings.map(bindingToTriple).join('\n');
};

const fetchFormInstanceByUri = async (
  formTtl: string,
  instanceUri: string,
): Promise<InstanceData | null> => {
  const constructQuery = await buildFormConstructQuery(formTtl, instanceUri);
  const result = await query(constructQuery);
  const ttl = result.results.bindings.map(bindingToTriple).join('\n');

  if (!ttl) return null;

  return {
    formInstanceTtl: `@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n${ttl}`,
    instanceUri,
  };
};

const updateFormInstance = async (
  instance: InstanceData,
  validatedContentTtl: string,
) => {
  const deltaQuery = await computeInstanceDeltaQuery(
    instance.formInstanceTtl,
    validatedContentTtl,
  );

  if (!deltaQuery) return;

  await query(deltaQuery);
};

const addFormInstance = async (instanceContent: string) => {
  await query(ttlToInsert(instanceContent));
};

const computeTombstoneInserts = (
  typesForTombstone: Array<{ uri: string; type: string }>,
) => {
  const inserts: string[] = [];
  const deletedAt = sparqlEscapeDateTime(new Date());

  typesForTombstone.forEach(({ type, uri }) => {
    const escapedType = sparqlEscapeUri(type);
    const escapedUri = sparqlEscapeUri(uri);
    inserts.push(`
  ${escapedUri} a <http://www.w3.org/ns/activitystreams#Tombstone> ;
         <http://www.w3.org/ns/activitystreams#deleted> ${deletedAt} ;
         <http://www.w3.org/ns/activitystreams#formerType> ${escapedType} .
    `);
  });
  return `INSERT {
    ${inserts.join('\n')}
  } `;
};

const getInstanceTypes = async (formTtl: string, instanceUri: string) => {
  const instance = await fetchFormInstanceByUri(formTtl, instanceUri);

  if (!instance) {
    return [];
  }

  return await comunicaRepo.getUriTypes(instance.formInstanceTtl);
};

const deleteFormInstance = async (formTtl: string, instanceUri: string) => {
  const instanceTypes = await getInstanceTypes(formTtl, instanceUri);

  const tombstoneInserts = computeTombstoneInserts(instanceTypes);
  const q = await buildFormDeleteQuery(formTtl, instanceUri, {
    beforeWhereSnippet: tombstoneInserts,
  });
  await query(q);
};

const getFormInstanceCount = async (targetType: string) => {
  const q = `
    PREFIX inst: <http://data.lblod.info/form-data/instances/>
    PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
    PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>
    SELECT (COUNT(DISTINCT ?uri) as ?count)
    WHERE {
        ?uri a ${sparqlEscapeUri(targetType)} .
        ?uri mu:uuid ?id .
    }`;

  const queryResult = await query(q);

  return parseInt(queryResult.results.bindings[0]?.count?.value, 10) || 0;
};

const getFormInstances = async (
  targetType: string,
  labelPredicates: string[],
  options?: { limit?: number; offset?: number },
) => {
  const labelJoin = labelPredicates
    .map((label) => {
      return `?uri ${sparqlEscapeUri(label.uri)} ?${label.name} .`;
    })
    .join('\n');
  const defaultPageSize = 20;
  const defaultOffset = 0;
  const q = `
    PREFIX inst: <http://data.lblod.info/form-data/instances/>
    PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
    PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>
    SELECT DISTINCT *
    WHERE {
        ?uri a ${sparqlEscapeUri(targetType)} .
        OPTIONAL { ${labelJoin} }
        ?uri mu:uuid ?id .
    }
    ORDER BY ?uri LIMIT ${options?.limit || defaultPageSize}
    OFFSET ${options?.offset || defaultOffset}
    `;

  const queryResult = await query(q);

  const instance_values: InstanceMinimal[] = [];

  queryResult.results.bindings.map((binding) => {
    const instance = {
      uri: binding.uri.value,
      id: binding.id.value,
    };
    labelPredicates.forEach((label) => {
      instance[label.name] = binding[label.name]
        ? binding[label.name].value
        : null;
    });
    instance_values.push(instance);
  });

  return instance_values;
};

const getFormInstancesWithCount = async (
  targetType: string,
  labelPredicates: string[],
  options?: { limit?: number; offset?: number },
) => {
  const [instances, count] = await Promise.all([
    getFormInstances(targetType, labelPredicates, options),
    getFormInstanceCount(targetType),
  ]);

  return { instances, count };
};

const fetchInstanceIdByUri = async (uri: string) => {
  const result = await query(`
    PREFIX mu: <http://mu.semte.ch/vocabularies/core/>

    SELECT ?id
    WHERE {
      <${uri}> mu:uuid ?id.
    } LIMIT 1
  `);

  if (result.results.bindings.length) {
    const binding = result.results.bindings[0];
    return binding.id.value;
  } else {
    return null;
  }
};

const fetchInstanceUriById = async (id: string) => {
  const result = await query(`
    PREFIX mu: <http://mu.semte.ch/vocabularies/core/>

    SELECT ?instance
    WHERE {
      ?instance mu:uuid ${sparqlEscapeString(id)} .
    } LIMIT 1
  `);

  if (result.results.bindings.length) {
    const binding = result.results.bindings[0];
    return binding.instance.value;
  } else {
    return null;
  }
};

const saveInstanceVersion = async (
  instanceUri: string,
  instanceTtl: string,
  creatorUri: string,
  description?: string,
) => {
  const { insertLines, prefixLines } =
    await ttlToTriplesAndPrefixes(instanceTtl);

  const historyGraph = `<http://mu.semte.ch/graphs/formHistory/${uuid()}>`;

  let descriptionInsert = '';
  if (description && description.length > 0) {
    descriptionInsert = `; dct:description ${sparqlEscapeString(description)} `;
  }

  const insertQuery = `
    ${prefixLines.join('\n')}
    PREFIX dct: <http://purl.org/dc/terms/>
    PREFIX dc: <http://purl.org/dc/elements/1.1/>
    PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>

    INSERT DATA {
      GRAPH <http://mu.semte.ch/graphs/formHistory> {
        ${historyGraph} a <http://mu.semte.ch/vocabularies/ext/FormHistory> ;
          dct:isVersionOf ${sparqlEscapeUri(instanceUri)} ;
          dct:issued ${sparqlEscapeDateTime(new Date())} ;
          dct:creator ${sparqlEscapeUri(creatorUri)} ${descriptionInsert}.
      }
      GRAPH ${historyGraph} {
        ${insertLines.join('.\n')}
      }
    }
  `;

  await updateSudo(insertQuery);
};

// unsecure because we don't know if the user has access to the instance
const unsecureGetInstanceHistoryItems = async (
  instanceId: string,
  options: { limit: number; offset: number },
) => {
  const { limit, offset } = options;
  const result = await querySudo(`
    PREFIX dct: <http://purl.org/dc/terms/>
    PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
    PREFIX form: <http://lblod.data.gift/vocabularies/forms/>

    SELECT DISTINCT ?history ?issued ?creatorId ?description
    WHERE {
      ?instance mu:uuid ${sparqlEscapeString(instanceId)} .
      GRAPH <http://mu.semte.ch/graphs/formHistory> {
        ?history dct:isVersionOf ?instance ;
        dct:issued ?issued ;
        dct:creator ?creator .
        OPTIONAL { ?history dct:description ?description }.
      }
      ?creator mu:uuid ?creatorId .
    }
    ORDER BY DESC(?issued)
    LIMIT ${limit}
    OFFSET ${offset}
  `);

  return result.results.bindings.map((binding) => {
    return {
      history: binding.history.value,
      issued: binding.issued.value,
      creator: binding.creatorId.value,
      description: binding.description?.value || null,
    };
  });
};

// unsecure because we don't know if the user has access to the instance
const unsecureGetInstanceHistoryCount = async (instanceId: string) => {
  const result = await querySudo(`
    PREFIX dct: <http://purl.org/dc/terms/>
    PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
    PREFIX form: <http://lblod.data.gift/vocabularies/forms/>

    SELECT (COUNT(DISTINCT ?history) AS ?count)
    WHERE {
      ?instance mu:uuid ${sparqlEscapeString(instanceId)} .
      GRAPH <http://mu.semte.ch/graphs/formHistory> {
        ?history dct:isVersionOf ?instance .
      }
    }
  `);

  const firstResult = result.results.bindings[0];
  return firstResult?.count?.value || 0;
};

// unsecure because we don't know if the user has access to the instance
const unsecureGetHistoryInstance = async (historyUri: string) => {
  const result = await querySudo(`
    CONSTRUCT {
      ?s ?p ?o
    }
    WHERE {
      GRAPH ${sparqlEscapeUri(historyUri)} {
        ?s ?p ?o
      }
    }
  `);

  return result.results.bindings.map(bindingToTriple).join('\n');
};

const hasAccessToInstance = async (instanceUri: string) => {
  const result = await query(`
    PREFIX mu: <http://mu.semte.ch/vocabularies/core/>

    SELECT * {
      ${sparqlEscapeUri(instanceUri)} a ?thing .
    } LIMIT 1
  `);

  return result.results.bindings.length > 0;
};

const hasAccessToInstanceId = async (instanceId: string) => {
  const result = await query(`
    PREFIX mu: <http://mu.semte.ch/vocabularies/core/>

    SELECT * {
      ?thing mu:uuid ${sparqlEscapeString(instanceId)}.
    } LIMIT 1
  `);

  return result.results.bindings.length > 0;
};

const hasAccessToHistoryInstance = async (historyInstanceUri: string) => {
  const instanceResult = await querySudo(`
    PREFIX dct: <http://purl.org/dc/terms/>

    SELECT ?instance
    WHERE {
      GRAPH <http://mu.semte.ch/graphs/formHistory> {
        ${sparqlEscapeUri(historyInstanceUri)} dct:isVersionOf ?instance .
      }
    } LIMIT 1
  `);

  const instanceUri = instanceResult.results.bindings[0]?.instance?.value;

  if (!instanceUri) {
    return false;
  }
  return hasAccessToInstance(instanceUri);
};

const getInstanceHistoryWithCount = async (
  instanceId: string,
  options: { limit: number; offset: number },
) => {
  const [hasAccess, count] = await Promise.all([
    hasAccessToInstanceId(instanceId),
    unsecureGetInstanceHistoryCount(instanceId),
  ]);
  if (!hasAccess) {
    return { instances: [], count: 0 };
  }
  return {
    instances: await unsecureGetInstanceHistoryItems(instanceId, options),
    count,
  };
};

const getHistoryInstance = async (historyUri: string) => {
  if (!(await hasAccessToHistoryInstance(historyUri))) {
    return null;
  }
  return unsecureGetHistoryInstance(historyUri);
};

const hasHistoryItems = async (instanceId: string) => {
  const result = await querySudo(`
    PREFIX dct: <http://purl.org/dc/terms/>
    PREFIX mu: <http://mu.semte.ch/vocabularies/core/>

    ASK {
      ?instance mu:uuid ${sparqlEscapeString(instanceId)} .
      GRAPH <http://mu.semte.ch/graphs/formHistory> {
        ?history dct:isVersionOf ?instance .
      }
    }
  `);

  return result.boolean;
};

export default {
  addFormInstance,
  deleteFormInstance,
  fetchFormInstanceByUri,
  fetchFormTtlById,
  fetchFormTtlByUri,
  fetchInstanceIdByUri,
  fetchInstanceUriById,
  getConceptSchemeTriples,
  getFormInstancesWithCount,
  getHistoryInstance,
  getInstanceHistoryWithCount,
  saveInstanceVersion,
  updateFormInstance,
  hasHistoryItems,
};
