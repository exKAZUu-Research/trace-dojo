export class Variable {
  name: string;
  value: string;

  constructor({ name, value }: { name: string; value: string }) {
    this.name = name;
    this.value = value;
  }
}
