import { TURTLE_METHOD_NAMES } from '../../interpreter/turtleWorld';

/** The English name of a Turtle method in C#, which capitalizes it as C# names methods (`forward` → `Forward`). */
export function turtleMethodName(name: string): string {
  return /^[a-z]/.test(name) ? name.charAt(0).toUpperCase() + name.slice(1) : name;
}

/** The declaration of the Turtle class, generated from the method names every language's Turtle shares. */
export const TURTLE_SOURCE = `
public class Turtle {
  public Turtle();
  public Turtle(int x, int y);
  public Turtle(int x, int y, string? color);
${Object.entries(TURTLE_METHOD_NAMES)
  .flatMap(([key, names]) =>
    names.map(
      (name) =>
        `  public ${key === 'canMoveForward' || key === 'isFrontPainted' ? 'bool' : 'void'} ${turtleMethodName(name)}();`
    )
  )
  .join('\n')}
}
`;
