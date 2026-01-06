import * as React from "react"
import { cn } from "@/lib/utils"

const Checkbox = React.forwardRef(({ className, onCheckedChange, ...props }, ref) => {
    const handleChange = (e) => {
        if (onCheckedChange) {
            onCheckedChange(e.target.checked)
        }
    }
    return (
        <input
            type="checkbox"
            ref={ref}
            onChange={handleChange}
            className={cn(
                "h-4 w-4 shrink-0 rounded-sm border border-primary ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 accent-primary",
                className
            )}
            {...props}
        />
    )
})
Checkbox.displayName = "Checkbox"

export { Checkbox }
