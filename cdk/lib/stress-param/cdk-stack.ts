import {Stack, StackProps} from "aws-cdk-lib";
import {Construct} from "constructs";
import {StressParameter} from "./stress-parameter";

export class StressParamStack extends Stack {
    constructor(scope:Construct, id:string, props?:StackProps) {
        super(scope, id, props);
        new StressParameter(this, 'stressParameter');
    }
}