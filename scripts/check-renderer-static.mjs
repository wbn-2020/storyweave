import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '@babel/parser'
import postcss from 'postcss'

// 仅解析源码，不创建 TypeScript 程序，不编译、不加载项目模块。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const renderer = path.join(root, 'src/renderer')
const failures = []
const files = []
function collect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) collect(target)
    else if (/\.(?:tsx?|css)$/.test(entry.name)) files.push(target)
  }
}
collect(renderer)
const css = new Map()
const variables = new Set()
for (const file of files) {
  for (const match of fs.readFileSync(file, 'utf8').matchAll(/(?:['"])?(--[\w-]+)(?:['"])?\s*:/g)) variables.add(match[1])
}
for (const file of files.filter((item) => item.endsWith('.css'))) {
  try {
    const sheet = postcss.parse(fs.readFileSync(file, 'utf8'), { from: file })
    const names = new Set()
    sheet.walkRules((rule) => {
      for (const match of rule.selector.matchAll(/\.([a-zA-Z_][\w-]*)/g)) names.add(match[1])
    })
    sheet.walkDecls('composes', (decl) => {
      if (!/^\.[\w-]+$/.test(decl.parent.selector)) failures.push(`${path.relative(root, file)}:${decl.source.start.line} invalid composes selector`)
    })
    sheet.walkDecls((decl) => {
      for (const match of decl.value.matchAll(/var\((--[\w-]+)\s*\)/g)) {
        if (!variables.has(match[1])) failures.push(`${path.relative(root, file)}:${decl.source.start.line} undefined variable ${match[1]}`)
      }
    })
    css.set(file, { names, sheet })
  } catch (error) { failures.push(error.message) }
}
for (const [file, { sheet }] of css) {
  sheet.walkDecls('composes', (decl) => {
    const match = decl.value.match(/^([\w -]+)\s+from\s+['"](.+)['"]$/)
    if (!match) return
    const source = css.get(path.resolve(path.dirname(file), match[2]))
    for (const name of match[1].trim().split(/\s+/)) {
      if (!source?.names.has(name)) failures.push(`${path.relative(root, file)}: missing composed class ${name} in ${match[2]}`)
    }
  })
}
function visit(value, visitor, scope = new Map()) {
  if (!value || typeof value !== 'object') return
  const local = ['Program', 'BlockStatement', 'ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'].includes(value.type) ? new Map(scope) : scope
  if (typeof value.type === 'string') visitor(value, local)
  for (const [key, child] of Object.entries(value)) {
    if (['loc', 'start', 'end', 'extra', 'comments', 'tokens'].includes(key)) continue
    if (Array.isArray(child)) child.forEach((item) => visit(item, visitor, local))
    else if (child && typeof child === 'object') visit(child, visitor, local)
  }
}
const trees = new Map()
function treeOf(file) {
  if (!trees.has(file)) trees.set(file, parse(fs.readFileSync(file, 'utf8'), { sourceType: 'module', plugins: ['typescript', 'jsx'] }))
  return trees.get(file)
}
function exportedNames(file) {
  const names = new Set()
  for (const statement of treeOf(file).program.body) {
    if (statement.type === 'ExportDefaultDeclaration') names.add('default')
    if (statement.type !== 'ExportNamedDeclaration') continue
    for (const specifier of statement.specifiers) names.add(specifier.exported.name ?? specifier.exported.value)
    if (statement.declaration?.id) names.add(statement.declaration.id.name)
    for (const declaration of statement.declaration?.declarations ?? []) {
      if (declaration.id.type === 'Identifier') names.add(declaration.id.name)
    }
  }
  return names
}
const iconSource = treeOf(path.join(renderer, 'components/StudioIcon.tsx'))
const iconMap = iconSource.program.body.flatMap((statement) => statement.declarations ?? []).find((item) => item.id.name === 'paths')?.init
const iconNames = new Set((iconMap?.expression ?? iconMap)?.properties.map((item) => item.key.name))
let sourceCount = 0, importedNames = 0, literalIcons = 0
for (const file of files.filter((item) => /\.tsx?$/.test(item))) {
  try {
    const tree = treeOf(file)
    sourceCount += 1
    const styles = new Map()
    for (const statement of tree.program.body) {
      if (statement.type !== 'ImportDeclaration' || !statement.source.value.startsWith('.')) continue
      const target = path.resolve(path.dirname(file), statement.source.value)
      const resolved = ['', '.ts', '.tsx', '.js', '/index.ts', '/index.tsx'].map((extension) => `${target}${extension}`).find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile())
      if (!resolved) failures.push(`${path.relative(root, file)}:${statement.loc.start.line} missing import ${statement.source.value}`)
      if (resolved && /\.[jt]sx?$/.test(resolved)) {
        const exported = exportedNames(resolved)
        for (const specifier of statement.specifiers) {
          if (specifier.type === 'ImportNamespaceSpecifier') continue
          const name = specifier.type === 'ImportDefaultSpecifier' ? 'default' : specifier.imported.name ?? specifier.imported.value
          importedNames += 1
          if (!exported.has(name)) failures.push(`${path.relative(root, file)}:${statement.loc.start.line} missing export ${name} in ${statement.source.value}`)
        }
      }
      if (target.endsWith('.module.css') && statement.specifiers[0]) styles.set(statement.specifiers[0].local.name, css.get(target)?.names)
    }
    visit(tree, (node, scope) => {
      if (node.type === 'JSXOpeningElement' && node.name.name === 'StudioIcon') {
        const name = node.attributes.find((item) => item.name?.name === 'name')?.value
        if (name?.type === 'StringLiteral') {
          literalIcons += 1
          if (!iconNames.has(name.value)) failures.push(`${path.relative(root, file)}:${node.loc.start.line} missing icon ${name.value}`)
        }
      }
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
        if (node.init?.type === 'Identifier') scope.set(node.id.name, scope.get(node.init.name))
        else if (node.init?.type === 'ObjectExpression') {
          const spread = node.init.properties.filter((property) => property.type === 'SpreadElement' && property.argument.type === 'Identifier')
          if (spread.length && spread.every((property) => scope.has(property.argument.name))) {
            scope.set(node.id.name, new Set(spread.flatMap((property) => [...(scope.get(property.argument.name) ?? [])])))
          }
        }
      }
      if (node.type !== 'MemberExpression' || node.computed || node.object.type !== 'Identifier' || node.property.type !== 'Identifier') return
      const names = scope.get(node.object.name)
      if (names && !names.has(node.property.name)) failures.push(`${path.relative(root, file)}:${node.loc.start.line} missing CSS ${node.object.name}.${node.property.name}`)
    }, styles)
  } catch (error) { failures.push(`${path.relative(root, file)}: ${error.message}`) }
}
for (const file of files) {
  const content = fs.readFileSync(file, 'utf8')
  if (/^(?:<{7}|={7}|>{7})/m.test(content)) failures.push(`${path.relative(root, file)}: conflict marker`)
  if (/(?:^|[/\\])(?:Stellar[^/\\]*|StudioPages|Dialog|Workspace|stellar)\.module\.css$/.test(file) && /#[\da-f]{3,8}\b|\b(?:rgb|hsl)a?\(/i.test(content)) failures.push(`${path.relative(root, file)}: literal color outside tokens`)
}
for (const failure of failures) console.error(failure)
console.log(`Static parse: ${sourceCount} TS/TSX, ${css.size} CSS; ${failures.length} findings. No compile, typecheck, tests or app execution.`)
console.log(`Local imported names: ${importedNames}; literal StudioIcon names: ${literalIcons}. Dynamic expressions and TypeScript value types are not checked.`)
process.exitCode = failures.length ? 1 : 0
