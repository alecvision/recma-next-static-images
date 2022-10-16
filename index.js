import { visit, SKIP, CONTINUE } from "estree-util-visit";
import fs from "node:fs";
import nodePath from "node:path";
import { URL } from "node:url";
import crypto from "node:crypto";
import nodeFetch from "node-fetch";
/**
 * Find the local identifier assigned to the imported JSX factory(s)
 * @example: `import theFactory from 'jsx'
 */
const getJsxFactorySpecifiers = (tree) => {
    const names = new Set();
    visit(tree, (node) => {
        if (node.type === "ImportSpecifier" &&
            "imported" in node &&
            /^jsxs?$/.test(node.imported.name)) {
            names.add(node.local.name);
            return SKIP;
        }
        return CONTINUE;
    });
    return names;
};
const generateImportDeclaration = (path, index) => ({
    source: {
        type: "Literal",
        value: path,
    },
    specifiers: [
        {
            type: "ImportDefaultSpecifier",
            local: {
                name: `static_image_${index}`,
                type: "Identifier",
            },
        },
    ],
    type: "ImportDeclaration",
});
const updateSourcePropertyNode = (index) => ({
    type: "Property",
    key: {
        type: "Identifier",
        name: "src",
    },
    value: {
        type: "Identifier",
        name: `static_image_${index}`,
    },
    kind: "init",
    method: false,
    shorthand: false,
    computed: false,
});
const recmaStaticImages = function (options) {
    /*
     * Extract config properties from the options object or, if nullish, an empty object.
     * If a propperty is undefined on the right, it may be set to its default value on the left.
     */
    const { cacheDirectory, fetcher: _fetch = nodeFetch } = options ?? {};
    if (!cacheDirectory)
        throw new Error("cacheDirectory is required");
    const cache = nodePath.resolve(cacheDirectory).replace(/\/+$/, "");
    if (!fs.existsSync(cache))
        fs.mkdirSync(cache);
    return async function (tree, vfile) {
        if (!vfile.history[0])
            throw new Error(`File history is empty for ${vfile}`);
        let imageCounter = 0;
        const jsxFactorySpecifiers = getJsxFactorySpecifiers(tree);
        const sourceDirectory = vfile.history[0].replace(/[^/]*$/, "");
        const imports = [];
        await visitAsync(tree, (node) => (node.type === "CallExpression" &&
            "callee" in node &&
            node.callee.type === "Identifier" &&
            jsxFactorySpecifiers.has(node.callee.name) &&
            node.arguments[0] &&
            node.arguments[0].type === "MemberExpression" &&
            node.arguments[0].property.type === "Identifier" &&
            node.arguments[0].property.name === "img" &&
            node.arguments[1] &&
            node.arguments[1].type === "ObjectExpression") ||
            false, async function (node) {
            const [argument0, argument1, ...rest] = node.arguments;
            const newProperties = [];
            for (const property of argument1.properties) {
                if (property.type !== "Property" ||
                    property.key.type !== "Identifier" ||
                    property.key.name !== "src" ||
                    property.value.type !== "Literal" ||
                    typeof property.value.value !== "string") {
                    newProperties.push(property);
                    continue;
                }
                imageCounter += 1;
                const value = property.value.value;
                const extension = value.split(".").pop();
                let url;
                let buffer;
                let path;
                try {
                    // will fail for relative paths
                    url = new URL(value);
                }
                catch {
                    // handle relative paths
                    const source = nodePath.resolve(sourceDirectory, value);
                    buffer = fs.readFileSync(source);
                    const hash = crypto
                        .createHash("sha256")
                        .update(buffer)
                        .digest("base64");
                    path = `${cache}/${hash}${extension ? `.${extension}` : ""}`;
                }
                if (url instanceof URL) {
                    // handle absolute URLs
                    const buffer = await _fetch(url.href).then((r) => {
                        if (!r?.body)
                            throw new Error(`Failed to fetch ${url?.href}`);
                        return r.body.read();
                    });
                    const hash = crypto
                        .createHash("sha256")
                        .update(buffer)
                        .digest("base64");
                    path = `${cache}/${hash}${extension ? `.${extension}` : ""}`;
                }
                if (!path)
                    throw new Error(`Missing path for image: ${value}`);
                if (!buffer)
                    throw new Error(`Missing buffer for image: ${value}`);
                fs.writeFileSync(path, buffer);
                const declaration = generateImportDeclaration(path, imageCounter);
                imports.push(declaration);
                newProperties.push(updateSourcePropertyNode(imageCounter));
            }
            node.arguments = [
                argument0,
                { ...argument1, properties: newProperties },
                ...rest,
            ];
        });
        await visitAsync(tree, (node) => node.type === "Program", async function (node) {
            for (const declaration of imports) {
                if (declaration)
                    node.body.unshift(declaration);
            }
        });
    };
};
export default recmaStaticImages;
async function visitAsync(tree, test, asyncVisitor) {
    const matches = [];
    visit(tree, (node) => {
        if (test(node))
            matches.push(node);
    });
    const promises = matches.map((match) => asyncVisitor(match));
    await Promise.all(promises);
}
