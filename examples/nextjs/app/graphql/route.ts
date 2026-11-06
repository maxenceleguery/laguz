import { createHandler } from "@laguzjs/server";
import { context, rootValue, schema } from "../../lib/schema";

export const POST = createHandler({ schema, rootValue, context });
