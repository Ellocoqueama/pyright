/*
 * parameterUtils.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 *
 * Utility functions for parameters.
 */

import { ParameterCategory } from '../parser/parseNodes';
import { isDunderName } from './symbolNameUtils';
import {
    ClassType,
    FunctionParameter,
    FunctionType,
    isClassInstance,
    isPositionOnlySeparator,
    isUnpackedClass,
    isVariadicTypeVar,
    Type,
} from './types';
import { partiallySpecializeType } from './typeUtils';

export function isTypedKwargs(param: FunctionParameter): boolean {
    return (
        param.category === ParameterCategory.KwargsDict &&
        isClassInstance(param.type) &&
        isUnpackedClass(param.type) &&
        ClassType.isTypedDictClass(param.type) &&
        !!param.type.details.typedDictEntries
    );
}

export enum ParameterSource {
    PositionOnly,
    PositionOrKeyword,
    KeywordOnly,
}

export interface VirtualParameterDetails {
    param: FunctionParameter;
    type: Type;
    defaultArgType?: Type | undefined;
    index: number;
    source: ParameterSource;
}

export interface ParameterListDetails {
    // Virtual parameter list that refers to original parameters
    params: VirtualParameterDetails[];

    // Counts of virtual parameters
    positionOnlyParamCount: number;
    positionParamCount: number;

    // Indexes into virtual parameter list
    kwargsIndex?: number;
    argsIndex?: number;
    firstKeywordOnlyIndex?: number;
    firstPositionOrKeywordIndex: number;

    // Other information
    hasUnpackedVariadicTypeVar: boolean;
    hasUnpackedTypedDict: boolean;
    unpackedKwargsTypedDictType?: ClassType;
}

// Examines the input parameters within a function signature and creates a
// "virtual list" of parameters, stripping out any markers and expanding
// any *args with unpacked tuples.
export function getParameterListDetails(type: FunctionType): ParameterListDetails {
    const result: ParameterListDetails = {
        firstPositionOrKeywordIndex: 0,
        positionParamCount: 0,
        positionOnlyParamCount: 0,
        params: [],
        hasUnpackedVariadicTypeVar: false,
        hasUnpackedTypedDict: false,
    };

    let positionOnlyIndex = type.details.parameters.findIndex((p) => isPositionOnlySeparator(p));

    // Handle the old (pre Python 3.8) way of specifying positional-only
    // parameters by naming them with "__".
    if (positionOnlyIndex < 0) {
        for (let i = 0; i < type.details.parameters.length; i++) {
            const p = type.details.parameters[i];
            if (p.category !== ParameterCategory.Simple) {
                break;
            }

            if (!p.name) {
                break;
            }

            if (isDunderName(p.name) || !p.name.startsWith('__')) {
                // We exempt "self" and "cls" in class and instance methods.
                if (i > 0 || FunctionType.isStaticMethod(type)) {
                    break;
                }

                continue;
            }

            positionOnlyIndex = i + 1;
        }
    }

    if (positionOnlyIndex >= 0) {
        result.firstPositionOrKeywordIndex = positionOnlyIndex;
    }

    for (let i = 0; i < positionOnlyIndex; i++) {
        if (type.details.parameters[i].hasDefault) {
            break;
        }

        result.positionOnlyParamCount++;
    }

    let sawKeywordOnlySeparator = false;

    const addVirtualParameter = (
        param: FunctionParameter,
        index: number,
        typeOverride?: Type,
        defaultArgTypeOverride?: Type,
        sourceOverride?: ParameterSource
    ) => {
        if (param.name) {
            let source: ParameterSource;
            if (sourceOverride !== undefined) {
                source = sourceOverride;
            } else if (param.category === ParameterCategory.ArgsList) {
                source = ParameterSource.PositionOnly;
            } else if (sawKeywordOnlySeparator) {
                source = ParameterSource.KeywordOnly;
            } else if (positionOnlyIndex >= 0 && index < positionOnlyIndex) {
                source = ParameterSource.PositionOnly;
            } else {
                source = ParameterSource.PositionOrKeyword;
            }

            result.params.push({
                param,
                index,
                type: typeOverride ?? FunctionType.getEffectiveParameterType(type, index),
                defaultArgType: defaultArgTypeOverride,
                source,
            });
        }
    };

    type.details.parameters.forEach((param, index) => {
        if (param.category === ParameterCategory.ArgsList) {
            // If this is an unpacked tuple, expand the entries.
            const paramType = FunctionType.getEffectiveParameterType(type, index);
            if (param.name && isUnpackedClass(paramType) && paramType.tupleTypeArguments) {
                const addToPositionalOnly = index < result.positionOnlyParamCount;

                paramType.tupleTypeArguments.forEach((tupleArg, tupleIndex) => {
                    const category =
                        isVariadicTypeVar(tupleArg.type) || tupleArg.isUnbounded
                            ? ParameterCategory.ArgsList
                            : ParameterCategory.Simple;

                    if (category === ParameterCategory.ArgsList) {
                        result.argsIndex = result.params.length;
                    }

                    if (isVariadicTypeVar(param.type)) {
                        result.hasUnpackedVariadicTypeVar = true;
                    }

                    addVirtualParameter(
                        {
                            category,
                            name: `${param.name}[${tupleIndex.toString()}]`,
                            isNameSynthesized: true,
                            type: tupleArg.type,
                            hasDeclaredType: true,
                        },
                        index,
                        tupleArg.type,
                        /* defaultArgTypeOverride */ undefined,
                        ParameterSource.PositionOnly
                    );

                    if (category === ParameterCategory.Simple) {
                        result.positionParamCount++;
                    }

                    if (tupleIndex > 0 && addToPositionalOnly) {
                        result.positionOnlyParamCount++;
                    }
                });

                // Normally, a VarArgList parameter (either named or as an unnamed separator)
                // would signify the start of keyword-only parameters. However, we can construct
                // callable signatures that defy this rule by using Callable and TypeVarTuples
                // or unpacked tuples.
                if (!sawKeywordOnlySeparator && (positionOnlyIndex < 0 || index >= positionOnlyIndex)) {
                    result.firstKeywordOnlyIndex = result.params.length;
                    sawKeywordOnlySeparator = true;
                }
            } else {
                if (param.name && result.argsIndex === undefined) {
                    result.argsIndex = result.params.length;

                    if (isVariadicTypeVar(param.type)) {
                        result.hasUnpackedVariadicTypeVar = true;
                    }
                }

                // Normally, a VarArgList parameter (either named or as an unnamed separator)
                // would signify the start of keyword-only parameters. However, we can construct
                // callable signatures that defy this rule by using Callable and TypeVarTuples
                // or unpacked tuples.
                if (!sawKeywordOnlySeparator && (positionOnlyIndex < 0 || index >= positionOnlyIndex)) {
                    result.firstKeywordOnlyIndex = result.params.length;
                    if (param.name) {
                        result.firstKeywordOnlyIndex++;
                    }
                    sawKeywordOnlySeparator = true;
                }

                addVirtualParameter(param, index);
            }
        } else if (param.category === ParameterCategory.KwargsDict) {
            sawKeywordOnlySeparator = true;

            const paramType = FunctionType.getEffectiveParameterType(type, index);

            // Is this an unpacked TypedDict? If so, expand the entries.
            if (isClassInstance(paramType) && isUnpackedClass(paramType) && paramType.details.typedDictEntries) {
                if (result.firstKeywordOnlyIndex === undefined) {
                    result.firstKeywordOnlyIndex = result.params.length;
                }

                const typedDictType = paramType;
                paramType.details.typedDictEntries.forEach((entry, name) => {
                    const specializedParamType = partiallySpecializeType(entry.valueType, typedDictType);

                    addVirtualParameter(
                        {
                            category: ParameterCategory.Simple,
                            name,
                            type: specializedParamType,
                            hasDeclaredType: true,
                            hasDefault: !entry.isRequired,
                        },
                        index,
                        specializedParamType
                    );
                });

                result.hasUnpackedTypedDict = true;
                result.unpackedKwargsTypedDictType = paramType;
            } else if (param.name) {
                if (result.kwargsIndex === undefined) {
                    result.kwargsIndex = result.params.length;
                }

                if (result.firstKeywordOnlyIndex === undefined) {
                    result.firstKeywordOnlyIndex = result.params.length;
                }

                addVirtualParameter(param, index);
            }
        } else if (param.category === ParameterCategory.Simple) {
            if (param.name && !sawKeywordOnlySeparator) {
                result.positionParamCount++;
            }

            addVirtualParameter(
                param,
                index,
                /* typeOverride */ undefined,
                type.specializedTypes?.parameterDefaultArgs
                    ? type.specializedTypes?.parameterDefaultArgs[index]
                    : undefined
            );
        }
    });

    return result;
}
