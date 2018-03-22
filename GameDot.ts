export class GameDot {
    x: number;
    y: number;
    color: number;
    canChange: boolean;
    lastPlayer: string; 

    constructor(x: number , y: number, color: number) {
        this.x = x;
        this.y = y;
        this.color = color;
        this.canChange = true;
        this.lastPlayer = " ";
    }
    /**
     * Returns true/false depending if the dot was changed!
     * @param x 
     * @param y 
     * @param color 
     * @param canChange 
     * @param lastPlayer 
     */
    setDot(x: number, y: number, color: number, canChange: boolean, lastPlayer: string): boolean {
        if (this.canChange) {
            this.x = x;
            this.y = y;
            this.color = color;
            this.canChange = canChange;
            this.lastPlayer = lastPlayer;
            return true;
        }
        else {
            return false;
        }

    }
}

export default GameDot;