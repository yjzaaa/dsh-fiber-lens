/** CSS Module 类型垫片：tsdown 构建时由 dsh-css-modules-inline 插件内联并注入。 */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
