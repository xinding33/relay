/**
 * Copyright (c) 2013-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @flow
 * @providesModule RelayFlowParser
 */

'use strict';

const GraphQL = require('graphql');
const RelayParser = require('RelayParser');

const invariant = require('invariant');

const {getOperationDefinitionAST} = require('RelaySchemaUtils');

import type {
  Fragment,
  Root,
} from 'RelayIR';
import type {DocumentNode, GraphQLSchema} from 'graphql';

type GraphQLLocation = {
  column: number,
  line: number,
};
type GraphQLValidationError = {
  message: string,
  locations: Array<GraphQLLocation>,
};

export type ExtractedRelayTags = {
  filename: string,
  tags: Array<string>,
}

export type ExtractedGQLDocuments = {
  filename: string,
  documents: Array<Fragment | Root>,
}

const {
  formatError,
  Source,
  validate,
} = GraphQL;

/**
 * Validates that a given DocumentNode is properly formed. Returns an Array
 * of ValidationErrors if there are errors.
 */
function validateDocument(
  document: DocumentNode,
  documentName: string,
  schema: GraphQLSchema
): ?Array<GraphQLValidationError> {
  invariant(
    document.definitions.length === 1,
    'You supplied a GraphQL document named `%s` with %d definitions, but ' +
    'it must have exactly one definition.',
    documentName,
    document.definitions.length
  );
  const definition = document.definitions[0];
  const isMutation =
    definition.kind === 'OperationDefinition' &&
    definition.operation === 'mutation';

  const rules = [
    require(
      'graphql/validation/rules/ArgumentsOfCorrectType'
    ).ArgumentsOfCorrectType,
    require(
      'graphql/validation/rules/DefaultValuesOfCorrectType'
    ).DefaultValuesOfCorrectType,
    require(
      'graphql/validation/rules/FieldsOnCorrectType'
    ).FieldsOnCorrectType,
    require(
      'graphql/validation/rules/FragmentsOnCompositeTypes'
    ).FragmentsOnCompositeTypes,
    require(
      'graphql/validation/rules/KnownArgumentNames'
    ).KnownArgumentNames,
    require(
      'graphql/validation/rules/KnownTypeNames'
    ).KnownTypeNames,
    require(
      'graphql/validation/rules/PossibleFragmentSpreads'
    ).PossibleFragmentSpreads,
    require(
      'graphql/validation/rules/VariablesInAllowedPosition'
    ).VariablesInAllowedPosition,
  ];
  if (!isMutation) {
    rules.push(
      require(
        'graphql/validation/rules/ProvidedNonNullArguments'
      ).ProvidedNonNullArguments
    );
  }
  const validationErrors = validate(schema, document, rules);

  if (validationErrors && validationErrors.length > 0) {
    return validationErrors.map(formatError);
  }
  return null;
}

/**
 * Parses a given string containing one or more GraphQL operations into an array
 * of GraphQL documents.
 */
function parse(
  source: string,
  schema: GraphQLSchema,
  sourceName: string = 'default',
): Array<Root | Fragment> {
  // We need to ignore these directives. The RelayParser cannot handle these
  // directives, so this needs to happen here.
  const PATTERN_LIST = ['@relay(pattern:true)', '@fixme_fat_interface'];
  const strippedSource = source.replace(/ /g,'');
  const patternFound = PATTERN_LIST.some(pattern => {
    const isSubstring = strippedSource.indexOf(pattern) !== -1;
    if (isSubstring) {
      console.warn(
        `Skipping Relay.QL template string because it contains ${pattern}: ${sourceName}`
      );
    }
    return isSubstring;
  });
  if (patternFound) {
    return [];
  }

  let ast = null;
  try {
    ast = GraphQL.parse(new Source(source, sourceName));
  } catch (e) {
    console.error('\n-- GraphQL Parsing Error --\n');
    console.error([
      'File:  ' + sourceName,
      'Error: ' + e.message,
    ].join('\n'));
    return [];
  }

  const validationErrors = validateDocument(ast, sourceName, schema);
  if (validationErrors) {
    const errorMessages = [];
    var sourceLines = source.split('\n');
    validationErrors.forEach(({message, locations}) => {
      errorMessages.push(message);
      console.error(
        '\n-- GraphQL Validation Error --\n'
      );
      console.error([
        'File:  ' + sourceName,
        'Error: ' + message,
        'Source:',
      ].join('\n'));
      locations.forEach(location => {
        var preview = sourceLines[location.line - 1];
        if (preview) {
          console.error([
            '> ',
            '> ' + preview,
            '> ' + ' '.repeat(location.column - 1) + '^^^',
          ].join('\n'));
        }
      });
    });
    return [];
  }

  const {definitions} = ast;
  definitions.forEach(definition => {
    if (definition.kind !== 'OperationDefinition' ||
        definition.operation !== 'mutation') {
        return;
    }

    const selections = definition.selectionSet.selections;
    // As of now, FB mutations should only have one input.
    invariant(
      selections.length <= 1,
      `Mutations should only have one argument, ${selections.length} found.`
    );

    // We need to manually add a `name` and a selection to each `selectionSet`
    // in order for this to be a valid GraphQL document. The RelayParser will
    // throw an error if we give it a "classic" mutation. `__typename` is a
    // valid field in *all* mutation payloads.
    const mutationField = selections[0];
    invariant(
      mutationField.kind === 'Field',
      'RelayFlowParser: Expected the first selection of a mutation to be a ' +
      'field, got `%s`.',
      mutationField.kind,
    );
    definition.name = mutationField.name;
    mutationField.selectionSet = {
      kind: 'SelectionSet',
      selections: [
        {
          kind: 'Field',
          name: {
            kind: 'Name',
            value: '__typename',
          },
        },
      ],
    };
  });

  const nodes = [];
  definitions.forEach(definition => {
    const operationDefinition = getOperationDefinitionAST(definition);
    if (operationDefinition) {
      nodes.push(RelayParser.transform(schema, operationDefinition));
    }
  });
  return nodes;
}

/**
 * Parses each extracted template literal from an array of ExtractedRelayTags
 * into a GraphQL Document type. Each element in the returned array is a
 * ExtractedGQLDocuments type which includes the filename.
 */
function transformFiles(
  extractedTags: Array<ExtractedRelayTags>,
  schema: GraphQLSchema,
): Array<ExtractedGQLDocuments> {
  const gqlMapping = [];
  extractedTags.forEach(file => {
    const documents = [];
    file.tags.forEach(tag => {
      const transformed = parse(
        tag,
        schema,
        file.filename
      );
      if (transformed.length) {
        documents.push(...transformed);
      }
    });

    if (documents.length) {
      gqlMapping.push({
        filename: file.filename,
        documents,
      });
    }
  });
  return gqlMapping;
}

module.exports = {
  transformFiles,
  parse,
};
